import { Contract, JsonRpcProvider, type InterfaceAbi } from "ethers";

export interface Deployment {
  contract: string;
  network: string;
  chainId: number;
  address: string;
  deploymentBlock: number;
  explorerUrl: string | null;
  publicRpcUrl: string | null;
  abi: InterfaceAbi;
}

declare const __DEPLOYMENT__: Deployment | null;

/** Build-time deployment info. Null = off-chain demo build (no registry configured). */
export const deployment: Deployment | null = __DEPLOYMENT__;

export const MILESTONE_INDEX = {
  THRESHOLD_FLAGGED: 1,
  SUPERINTENDENT_APPLICATION: 2,
  APPLICATION_FILED: 3,
  ORDER_ATTESTED: 4,
  ORDER_RECEIVED_BY_PRISON: 5,
  RELEASE_ACKNOWLEDGED: 6,
} as const;

export const MILESTONE_NAMES = [
  "NONE",
  "THRESHOLD_FLAGGED",
  "SUPERINTENDENT_APPLICATION",
  "APPLICATION_FILED",
  "ORDER_ATTESTED",
  "ORDER_RECEIVED_BY_PRISON",
  "RELEASE_ACKNOWLEDGED",
] as const;

export const ORDER_STATUS = ["NONE", "ACTIVE", "REVOKED", "SUPERSEDED"] as const;
export const DOCUMENT_KIND = ["NONE", "APPLICATION_PDF", "ORDER_PDF", "ORDER_STRUCTURED"] as const;

let readProvider: JsonRpcProvider | null = null;

/** Read-only provider on the public RPC (no wallet needed). */
export function publicProvider(): JsonRpcProvider | null {
  if (!deployment?.publicRpcUrl) return null;
  readProvider ??= new JsonRpcProvider(deployment.publicRpcUrl, deployment.chainId, { staticNetwork: true });
  return readProvider;
}

export function readRegistry(): Contract | null {
  const provider = publicProvider();
  return provider && deployment ? new Contract(deployment.address, deployment.abi, provider) : null;
}

export function explorerTx(hash: string): string | null {
  return deployment?.explorerUrl ? `${deployment.explorerUrl}/tx/${hash}` : null;
}

export function explorerAddress(address: string): string | null {
  return deployment?.explorerUrl ? `${deployment.explorerUrl}/address/${address}` : null;
}

export function networkLabel(): string {
  if (!deployment) return "No registry";
  if (deployment.chainId === 31337) return "Local Hardhat chain";
  if (deployment.chainId === 11155111) return "Sepolia testnet";
  return `${deployment.network} (chain ${deployment.chainId})`;
}
