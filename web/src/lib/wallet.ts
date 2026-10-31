import { BrowserProvider, Contract, getAddress, toBeHex, type Eip1193Provider } from "ethers";
import { deployment } from "./deployment";

declare global {
  interface Window {
    ethereum?: Eip1193Provider & { on?: (e: string, cb: (...a: unknown[]) => void) => void; removeListener?: (e: string, cb: (...a: unknown[]) => void) => void };
  }
}

export type TxPhase = "idle" | "checking" | "awaiting_wallet" | "submitted" | "recording" | "confirmed" | "failed";

export interface TxStatus {
  phase: TxPhase;
  txHash?: string;
  message?: string;
}

export type ContractRole = "LAWYER_ROLE" | "ISSUER_ROLE" | "PRISON_ROLE";

/** Plain-language explanations of BailRegistry custom errors. */
const CONTRACT_ERRORS: Record<string, string> = {
  AccessControlUnauthorizedAccount: "Your wallet does not hold the required role on the registry.",
  CaseNotFound: "This case is not registered on-chain yet. Wait for anchoring to finish.",
  CaseAlreadyRegistered: "This case is already registered on-chain.",
  DocumentAlreadyRegistered: "This exact document is already registered on-chain.",
  DuplicateHashes: "The structured order hash and the PDF hash must differ.",
  ApplicationNotFound: "That application does not exist on-chain.",
  ApplicationCaseMismatch: "That application belongs to a different case.",
  ApplicationAlreadyHasOrder: "An order has already been attested on this application.",
  OrderAlreadyExists: "That order ID is already used.",
  OrderNotFound: "That order does not exist on-chain.",
  OrderCaseMismatch: "That order belongs to a different case.",
  OrderNotActive: "The order is not ACTIVE (it was revoked or superseded).",
  MilestoneNotAttestable: "That milestone cannot be attested directly.",
  MilestoneAlreadyRecorded: "This milestone is already recorded on-chain.",
  OrderAlreadyReceived: "Receipt of this order is already recorded.",
  OrderNotReceived: "Record receipt of the order before acknowledging release.",
  UnexpectedOrderId: "This milestone must not reference an order.",
  ZeroValue: "A required value was empty.",
};

export class WalletError extends Error {}

/** Translate wallet / RPC / contract errors into plain language. */
export function explainWalletError(err: unknown): string {
  if (err instanceof WalletError) return err.message;
  const e = err as {
    code?: string | number;
    info?: { error?: { code?: number; message?: string } };
    revert?: { name?: string };
    shortMessage?: string;
    message?: string;
  };
  const inner = e?.info?.error;
  if (e?.code === "ACTION_REJECTED" || e?.code === 4001 || inner?.code === 4001) return "You rejected the request in your wallet.";
  if (e?.revert?.name) return CONTRACT_ERRORS[e.revert.name] ?? `The registry rejected the transaction (${e.revert.name}).`;
  if (e?.code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(e?.message ?? ""))
    return "Your wallet has no test ETH to pay for gas.";
  if (e?.code === "NETWORK_ERROR" || /failed to fetch|could not detect network|ECONNREFUSED/i.test(e?.message ?? ""))
    return "The blockchain RPC is unavailable. Check that the network is running and reachable.";
  if (e?.code === -32002 || inner?.code === -32002) return "Your wallet already has a pending request. Open it to continue.";
  return e?.shortMessage ?? inner?.message ?? e?.message ?? "Unknown wallet error.";
}

export function hasWallet(): boolean {
  return typeof window !== "undefined" && Boolean(window.ethereum);
}

async function ensureNetwork(): Promise<void> {
  if (!deployment) throw new WalletError("No registry is configured (off-chain demo).");
  const eth = window.ethereum!;
  const wanted = toBeHex(deployment.chainId);
  const current = (await eth.request({ method: "eth_chainId" })) as string;
  if (BigInt(current) === BigInt(deployment.chainId)) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: wanted }] });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 4902 && deployment.publicRpcUrl) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: wanted,
            chainName: deployment.chainId === 31337 ? "Hardhat Local" : deployment.network,
            rpcUrls: [deployment.publicRpcUrl],
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            blockExplorerUrls: deployment.explorerUrl ? [deployment.explorerUrl] : undefined,
          },
        ],
      });
    } else if (code === 4001) {
      throw new WalletError("You declined to switch networks. Switch your wallet to the registry's network to continue.");
    } else {
      throw new WalletError(
        `Wrong network. Switch your wallet to ${deployment.chainId === 31337 ? "the local Hardhat chain (31337)" : `chain ${deployment.chainId}`}.`,
      );
    }
  }
}

export async function connectWallet(): Promise<string> {
  if (!hasWallet()) throw new WalletError("No browser wallet found. Install MetaMask to sign attestations.");
  try {
    const accounts = (await window.ethereum!.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts[0]) throw new WalletError("No wallet account available.");
    return getAddress(accounts[0]);
  } catch (err) {
    throw new WalletError(explainWalletError(err));
  }
}

/**
 * Send a registry transaction from the user's wallet with pre-flight checks:
 * correct network, account matches the user's mapped wallet, wallet holds the
 * role, has gas money, and the call would not revert.
 */
export async function sendRegistryTx(opts: {
  method: string;
  args: unknown[];
  role: ContractRole;
  expectedAccount: string | null;
  onStatus: (s: TxStatus) => void;
}): Promise<string> {
  const { method, args, role, expectedAccount, onStatus } = opts;
  if (!deployment) throw new WalletError("Off-chain demo — no blockchain attestations.");
  if (!expectedAccount) throw new WalletError("Your demo account has no mapped wallet address.");
  onStatus({ phase: "checking", message: "Checking wallet, network and role…" });

  const account = await connectWallet();
  if (account.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new WalletError(
      `Connected wallet ${short(account)} is not the wallet mapped to your account (${short(expectedAccount)}). Switch accounts in MetaMask.`,
    );
  }
  await ensureNetwork();

  const provider = new BrowserProvider(window.ethereum!, "any");
  const signer = await provider.getSigner(account);
  const registry = new Contract(deployment.address, deployment.abi, signer);
  try {
    const roleId = await registry.getFunction(role)();
    if (!(await registry.getFunction("hasRole")(roleId, account))) {
      throw new WalletError(`Your wallet does not hold ${role.replace("_ROLE", "").toLowerCase()} role on the registry.`);
    }
    if ((await provider.getBalance(account)) === 0n) throw new WalletError("Your wallet has no test ETH to pay for gas.");
    await registry.getFunction(method).staticCall(...args);
  } catch (err) {
    throw new WalletError(explainWalletError(err));
  }

  onStatus({ phase: "awaiting_wallet", message: "Confirm the transaction in your wallet…" });
  let txHash: string;
  try {
    const tx = await registry.getFunction(method)(...args);
    txHash = tx.hash as string;
    onStatus({ phase: "submitted", txHash, message: "Submitted — waiting for confirmation…" });
    const receipt = await waitForReceipt(provider, txHash);
    if (!receipt || receipt.status !== 1) throw new WalletError("The transaction failed on-chain.");
  } catch (err) {
    throw new WalletError(explainWalletError(err));
  }
  return txHash;
}

/**
 * Poll for the receipt (= 1 confirmation) instead of tx.wait(): ethers compares against a
 * briefly cached block number and may then wait for a new block, which never arrives on an
 * idle automining local chain.
 */
async function waitForReceipt(provider: BrowserProvider, txHash: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) return receipt;
    if (Date.now() > deadline) throw new WalletError("Timed out waiting for confirmation. Check the transaction in your wallet or explorer.");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function short(addr: string | null | undefined, n = 6): string {
  if (!addr) return "—";
  return addr.length > 2 * n + 2 ? `${addr.slice(0, n + 2)}…${addr.slice(-4)}` : addr;
}
