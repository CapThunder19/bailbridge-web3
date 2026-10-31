import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(SERVER_ROOT, "..");

dotenv.config({ path: path.join(REPO_ROOT, ".env") });

/** Well-known Hardhat development account #0 key. Only ever used on chainId 31337. */
const HARDHAT_ACCOUNT_0_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
/** Default Hardhat accounts used for demo users on a local chain. */
const HARDHAT_DEFAULT_WALLETS = {
  lawyer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  issuer: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  prison: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
};

export interface Deployment {
  contract: string;
  network: string;
  chainId: number;
  address: string;
  deploymentBlock: number;
  explorerUrl: string | null;
  publicRpcUrl: string | null;
  roles?: { admin: string; registrars: string[]; lawyers: string[]; issuers: string[]; prisons: string[] };
  abi: unknown[];
}

function loadDeployment(file: string): Deployment | null {
  if (!existsSync(file)) return null;
  const d = JSON.parse(readFileSync(file, "utf8")) as Deployment;
  return d.address ? d : null;
}

export interface ChainConfig {
  rpcUrl: string;
  registrarKey: string;
  deployment: Deployment;
}

export interface AppConfig {
  port: number;
  dbPath: string;
  storageDir: string;
  publicWebUrl: string;
  commitmentSecret: string;
  demoPassword: string;
  demoWallets: { lawyer: string | null; issuer: string | null; prison: string | null };
  gemini: { apiKey: string | null; model: string };
  /** Null = off-chain demo mode. */
  chain: ChainConfig | null;
  /** Why chain mode is off (for logs/banner). */
  offChainReason: string | null;
  webDistDir: string;
  cookieSecure: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const deploymentFile = env.DEPLOYMENT_FILE
    ? path.resolve(REPO_ROOT, env.DEPLOYMENT_FILE)
    : path.join(SERVER_ROOT, "src", "generated", "deployment.json");
  const deployment = env.CHAIN_DISABLED === "true" ? null : loadDeployment(deploymentFile);

  let chain: ChainConfig | null = null;
  let offChainReason: string | null = null;
  if (env.CHAIN_DISABLED === "true") {
    offChainReason = "CHAIN_DISABLED=true";
  } else if (!deployment) {
    offChainReason = `no deployment file at ${path.relative(REPO_ROOT, deploymentFile)}`;
  } else {
    const isLocal = deployment.chainId === 31337;
    const rpcUrl = env.RPC_URL || (isLocal ? (deployment.publicRpcUrl ?? "http://127.0.0.1:8545") : "");
    const registrarKey = env.REGISTRAR_PRIVATE_KEY || (isLocal ? HARDHAT_ACCOUNT_0_KEY : "");
    if (!rpcUrl) offChainReason = "RPC_URL is not set";
    else if (!registrarKey) offChainReason = "REGISTRAR_PRIVATE_KEY is not set";
    else chain = { rpcUrl, registrarKey, deployment };
  }

  const roles = deployment?.roles;
  const localDefaults = deployment?.chainId === 31337 || !deployment ? HARDHAT_DEFAULT_WALLETS : null;
  const wallet = (envValue: string | undefined, fromRoles: string | undefined, fallback: string | undefined) =>
    envValue || fromRoles || fallback || null;

  const commitmentSecret = env.COMMITMENT_SECRET || "";
  if (!commitmentSecret && env.NODE_ENV === "production") {
    throw new Error("COMMITMENT_SECRET must be set in production");
  }

  return {
    port: Number(env.PORT || 4000),
    dbPath: env.DB_PATH ? path.resolve(REPO_ROOT, env.DB_PATH) : path.join(SERVER_ROOT, "data", "bailbridge.db"),
    storageDir: env.STORAGE_DIR ? path.resolve(REPO_ROOT, env.STORAGE_DIR) : path.join(SERVER_ROOT, "storage"),
    publicWebUrl: (env.PUBLIC_WEB_URL || "http://localhost:5173").replace(/\/$/, ""),
    commitmentSecret: commitmentSecret || "dev-only-commitment-secret-change-me",
    demoPassword: env.DEMO_PASSWORD || "bailbridge-demo",
    demoWallets: {
      lawyer: wallet(env.DEMO_LAWYER_WALLET, roles?.lawyers[0], localDefaults?.lawyer),
      issuer: wallet(env.DEMO_ISSUER_WALLET, roles?.issuers[0], localDefaults?.issuer),
      prison: wallet(env.DEMO_PRISON_WALLET, roles?.prisons[0], localDefaults?.prison),
    },
    gemini: { apiKey: env.GEMINI_API_KEY || null, model: env.GEMINI_MODEL || "gemini-2.5-flash" },
    chain,
    offChainReason,
    webDistDir: path.join(REPO_ROOT, "web", "dist"),
    cookieSecure: env.COOKIE_SECURE === "true",
  };
}
