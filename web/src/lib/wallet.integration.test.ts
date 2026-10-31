/**
 * Browser wallet path against a LIVE local stack (hardhat node + deployed registry + API server).
 * window.ethereum is a minimal EIP-1193 shim that forwards to the Hardhat node, whose
 * accounts are unlocked — so eth_sendTransaction behaves like MetaMask after the user approves.
 *
 * Requires: `npm run chain`, `npm run deploy:local`, `npm run server:dev`. Skipped (and reported
 * as skipped) when they are not running.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RPC = "http://127.0.0.1:8545";
const API = "http://localhost:4000/api";
const deploymentFile = fileURLToPath(new URL("../generated/deployment.json", import.meta.url));
const ACCOUNTS = {
  lawyer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  issuer: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  noRole: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc", // Hardhat #5, holds no role
};

async function reachable(): Promise<boolean> {
  try {
    const rpc = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }) });
    const api = await fetch(`${API}/public/config`);
    const cfg = (await api.json()) as { chain: { enabled: boolean } };
    return rpc.ok && cfg.chain.enabled && existsSync(deploymentFile);
  } catch {
    return false;
  }
}
const live = await reachable();

vi.mock("./deployment", async (importOriginal) => {
  const real = await importOriginal<typeof import("./deployment")>();
  const file = fileURLToPath(new URL("../generated/deployment.json", import.meta.url));
  return { ...real, deployment: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null };
});

let activeAccount = ACCOUNTS.lawyer;
function installShim() {
  let id = 0;
  (globalThis as unknown as { window: unknown }).window = {
    ethereum: {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [activeAccount];
        const res = await fetch(RPC, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
        });
        const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
        if (body.error) throw Object.assign(new Error(body.error.message), body.error);
        return body.result;
      },
    },
  };
}

async function loginCookie(username: string): Promise<string> {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: process.env.DEMO_PASSWORD ?? "bailbridge-demo" }),
  });
  if (!res.ok) throw new Error(`login failed ${res.status}`);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

describe.skipIf(!live)("browser wallet flow on a live local stack", () => {
  let caseId: string;
  let draft: Uint8Array;
  let lawyerCookie: string;

  beforeAll(async () => {
    installShim();
    const cw = await loginCookie("caseworker");
    const start = new Date(Date.now() - 600 * 86_400_000).toISOString().slice(0, 10);
    const created = await fetch(`${API}/cases`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cw },
      body: JSON.stringify({
        personName: "Demo Wallet Test (synthetic)",
        age: 30,
        caseRef: `SYN/WALLET/${Date.now()}`,
        court: "Demo Sessions Court",
        stage: "Trial",
        offenceId: "bns-303-2-first",
        custodyPeriods: [{ start, end: null }],
        previousConviction: "yes",
        otherPendingCases: "no",
        excludedDays: 0,
        excludedNote: "",
      }),
    });
    caseId = ((await created.json()) as { case: { id: string } }).case.id;
    for (let i = 0; i < 40; i++) {
      const d = (await (await fetch(`${API}/cases/${caseId}`, { headers: { cookie: cw } })).json()) as { case: { chainStatus: string } };
      if (d.case.chainStatus === "anchored") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    lawyerCookie = await loginCookie("lawyer");
    draft = new Uint8Array(await (await fetch(`${API}/cases/${caseId}/application-draft.pdf`, { headers: { cookie: lawyerCookie } })).arrayBuffer());
  }, 60_000);

  it("refuses when the connected account is not the user's mapped wallet", async () => {
    const { sendRegistryTx } = await import("./wallet");
    const { hashBytes } = await import("./hash");
    activeAccount = ACCOUNTS.issuer;
    await expect(
      sendRegistryTx({ method: "fileApplication", args: [caseId, hashBytes(draft)], role: "LAWYER_ROLE", expectedAccount: ACCOUNTS.lawyer, onStatus: () => {} }),
    ).rejects.toThrow(/not the wallet mapped to your account/);
  });

  it("refuses when the wallet lacks the role", async () => {
    const { sendRegistryTx } = await import("./wallet");
    const { hashBytes } = await import("./hash");
    activeAccount = ACCOUNTS.noRole;
    await expect(
      sendRegistryTx({ method: "fileApplication", args: [caseId, hashBytes(draft)], role: "LAWYER_ROLE", expectedAccount: ACCOUNTS.noRole, onStatus: () => {} }),
    ).rejects.toThrow(/does not hold lawyer role/);
  });

  it("files, uploads the same bytes, and a second filing of the same bytes is refused in pre-flight", async () => {
    const { sendRegistryTx } = await import("./wallet");
    const { hashBytes } = await import("./hash");
    activeAccount = ACCOUNTS.lawyer;
    const phases: string[] = [];
    const txHash = await sendRegistryTx({
      method: "fileApplication",
      args: [caseId, hashBytes(draft)],
      role: "LAWYER_ROLE",
      expectedAccount: ACCOUNTS.lawyer,
      onStatus: (s) => phases.push(s.phase),
    });
    expect(phases).toEqual(["checking", "awaiting_wallet", "submitted"]);
    const up = await fetch(`${API}/cases/${caseId}/applications?txHash=${txHash}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", cookie: lawyerCookie },
      body: draft as BodyInit,
    });
    expect(up.status).toBe(201);

    await expect(
      sendRegistryTx({ method: "fileApplication", args: [caseId, hashBytes(draft)], role: "LAWYER_ROLE", expectedAccount: ACCOUNTS.lawyer, onStatus: () => {} }),
    ).rejects.toThrow(/already registered on-chain/);
  }, 60_000);
});
