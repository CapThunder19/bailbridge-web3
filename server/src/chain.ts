import { Contract, JsonRpcProvider, NonceManager, Wallet, getAddress, type InterfaceAbi, type LogDescription } from "ethers";
import type { ChainConfig } from "./config.js";

export const MILESTONES = [
  "NONE",
  "THRESHOLD_FLAGGED",
  "SUPERINTENDENT_APPLICATION",
  "APPLICATION_FILED",
  "ORDER_ATTESTED",
  "ORDER_RECEIVED_BY_PRISON",
  "RELEASE_ACKNOWLEDGED",
] as const;
export type MilestoneName = Exclude<(typeof MILESTONES)[number], "NONE">;
export const milestoneIndex = (m: MilestoneName) => MILESTONES.indexOf(m);

export const ORDER_STATUSES = ["NONE", "ACTIVE", "REVOKED", "SUPERSEDED"] as const;

/** A user-facing chain error with a plain-language message. */
export class ChainError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

export interface ConfirmedEvent {
  event: LogDescription;
  from: string;
  blockNumber: number;
  timestamp: number;
  txHash: string;
}

/** Translate ethers/RPC errors into plain language. */
export function explainChainError(err: unknown): string {
  const e = err as { code?: string; shortMessage?: string; message?: string; revert?: { name?: string } };
  if (e?.revert?.name) return `Contract rejected the transaction (${e.revert.name}).`;
  if (e?.code === "NETWORK_ERROR" || e?.code === "ECONNREFUSED" || /ECONNREFUSED|fetch failed|getaddrinfo/i.test(e?.message ?? ""))
    return "Blockchain RPC is unavailable.";
  if (e?.code === "INSUFFICIENT_FUNDS") return "The registrar wallet has no test ETH for gas.";
  if (e?.code === "TIMEOUT") return "Timed out waiting for the blockchain.";
  return e?.shortMessage ?? e?.message ?? "Unknown blockchain error.";
}

export class ChainService {
  readonly provider: JsonRpcProvider;
  readonly registrar: Wallet;
  /** Tracks nonces locally: ethers briefly caches identical RPC reads, so back-to-back txs could reuse a nonce. */
  private readonly signer: NonceManager;
  readonly contract: Contract;
  readonly address: string;
  readonly chainId: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly config: ChainConfig) {
    const { deployment } = config;
    this.chainId = deployment.chainId;
    this.provider = new JsonRpcProvider(config.rpcUrl, deployment.chainId, { staticNetwork: true });
    this.registrar = new Wallet(config.registrarKey, this.provider);
    this.signer = new NonceManager(this.registrar);
    this.address = getAddress(deployment.address);
    this.contract = new Contract(this.address, deployment.abi as InterfaceAbi, this.signer);
  }

  /** Serialise registrar transactions so nonces never collide. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(method: string, args: unknown[]): Promise<{ txHash: string; blockNumber: number }> {
    return this.enqueue(async () => {
      try {
        const fn = this.contract.getFunction(method);
        const tx = await fn(...args);
        const receipt = await tx.wait(1, 120_000);
        if (!receipt || receipt.status !== 1) throw new ChainError(`${method} transaction failed.`);
        return { txHash: receipt.hash as string, blockNumber: receipt.blockNumber as number };
      } catch (err) {
        this.signer.reset(); // re-read the nonce from the chain after any failure
        if (err instanceof ChainError) throw err;
        throw new ChainError(explainChainError(err));
      }
    });
  }

  registerCase(caseId: string, recordCommitment: string) {
    return this.send("registerCase", [caseId, recordCommitment]);
  }

  anchorScreening(caseId: string, screeningCommitment: string, ruleVersion: number) {
    return this.send("anchorScreening", [caseId, screeningCommitment, ruleVersion]);
  }

  flagThreshold(caseId: string, evidenceCommitment: string) {
    return this.send("attestMilestone", [
      caseId,
      "0x" + "00".repeat(32),
      milestoneIndex("THRESHOLD_FLAGGED"),
      evidenceCommitment,
    ]);
  }

  async isCaseRegistered(caseId: string): Promise<boolean> {
    const c = await this.contract.getFunction("getCase")(caseId);
    return Boolean(c.exists);
  }

  /** Health check: RPC reachable and contract code present. */
  async health(): Promise<{ ok: boolean; message: string }> {
    try {
      const code = await this.provider.getCode(this.address);
      if (code === "0x") return { ok: false, message: "No contract code at the configured address." };
      return { ok: true, message: "Connected." };
    } catch (err) {
      return { ok: false, message: explainChainError(err) };
    }
  }

  /**
   * Wait for a wallet-signed transaction, check it succeeded, was sent to the
   * registry, was signed by `expectedFrom`, and emitted `eventName`.
   */
  async confirmWalletTx(txHash: string, eventName: string, expectedFrom: string): Promise<ConfirmedEvent> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new ChainError("Invalid transaction hash.", 400);
    let receipt;
    let tx;
    try {
      receipt = await this.provider.waitForTransaction(txHash, 1, 120_000);
      tx = await this.provider.getTransaction(txHash);
    } catch (err) {
      throw new ChainError(explainChainError(err));
    }
    if (!receipt || !tx) throw new ChainError("Transaction not found on the configured network.", 404);
    if (receipt.status !== 1) throw new ChainError("The transaction failed on-chain.", 409);
    if (!receipt.to || getAddress(receipt.to) !== this.address)
      throw new ChainError("The transaction was not sent to the BailBridge registry.", 409);
    if (getAddress(tx.from) !== getAddress(expectedFrom))
      throw new ChainError("The transaction was signed by a different wallet than your account's mapped wallet.", 403);

    const event = receipt.logs
      .filter((l) => getAddress(l.address) === this.address)
      .map((l) => {
        try {
          return this.contract.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((d): d is LogDescription => d?.name === eventName);
    if (!event) throw new ChainError(`The transaction did not emit ${eventName}.`, 409);

    const block = await this.provider.getBlock(receipt.blockNumber);
    return {
      event,
      from: getAddress(tx.from),
      blockNumber: receipt.blockNumber,
      timestamp: block?.timestamp ?? Math.floor(Date.now() / 1000),
      txHash: receipt.hash,
    };
  }

  /** Find a specific event in a confirmed tx (e.g. MilestoneAttested alongside ApplicationFiled). */
  async eventsInTx(txHash: string, eventName: string): Promise<LogDescription[]> {
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (!receipt) return [];
    return receipt.logs
      .filter((l) => getAddress(l.address) === this.address)
      .map((l) => {
        try {
          return this.contract.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .filter((d): d is LogDescription => d?.name === eventName);
  }

  async getApplication(appId: bigint | number) {
    return this.contract.getFunction("getApplication")(appId);
  }

  async getOrder(orderId: string) {
    return this.contract.getFunction("getOrder")(orderId);
  }

  explorerTx(txHash: string): string | null {
    const base = this.config.deployment.explorerUrl;
    return base ? `${base}/tx/${txHash}` : null;
  }
}
