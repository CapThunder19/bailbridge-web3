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

// ---------------------------------------------------------------------------
// Full journey through the browser modules: prison + issuer signing, /verify logic,
// revocation, release clock. Same live-stack requirement as above.
// ---------------------------------------------------------------------------

const PRISON = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const today = () => new Date().toISOString().slice(0, 10);

async function call<T>(path: string, cookie: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${path}: ${res.status} ${json.error}`);
  return json;
}

async function newReachedCase(cw: string, ref: string): Promise<string> {
  const start = new Date(Date.now() - 600 * 86_400_000).toISOString().slice(0, 10);
  const d = await call<{ case: { id: string } }>("/cases", cw, {
    personName: "Demo Journey (synthetic)",
    age: 40,
    caseRef: ref,
    court: "Demo Sessions Court",
    stage: "Trial",
    offenceId: "bns-303-2-first",
    custodyPeriods: [{ start, end: null }],
    previousConviction: "yes",
    otherPendingCases: "no",
    excludedDays: 0,
    excludedNote: "",
  });
  for (let i = 0; i < 40; i++) {
    const c = await call<{ case: { chainStatus: string } }>(`/cases/${d.case.id}`, cw);
    if (c.case.chainStatus === "anchored") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return d.case.id;
}

describe.skipIf(!live)("full browser-side journey on a live local stack", () => {
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    installShim();
    for (const u of ["caseworker", "lawyer", "issuer", "prison"]) cookies[u] = await loginCookie(u);
  });

  async function fileAndAttest(caseId: string) {
    const { sendRegistryTx } = await import("./wallet");
    const { hashBytes } = await import("./hash");
    const bytes = new Uint8Array(
      await (await fetch(`${API}/cases/${caseId}/application-draft.pdf`, { headers: { cookie: cookies.lawyer! } })).arrayBuffer(),
    );
    activeAccount = ACCOUNTS.lawyer;
    const fileTx = await sendRegistryTx({
      method: "fileApplication",
      args: [caseId, hashBytes(bytes)],
      role: "LAWYER_ROLE",
      expectedAccount: ACCOUNTS.lawyer,
      onStatus: () => {},
    });
    const up = await fetch(`${API}/cases/${caseId}/applications?txHash=${fileTx}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", cookie: cookies.lawyer! },
      body: bytes as BodyInit,
    });
    const appRow = ((await up.json()) as { application: { id: number } }).application;

    activeAccount = ACCOUNTS.issuer;
    const prep = await call<{ orderId: string; chainAppId: number; structuredHash: string; pdfHash: string }>(
      `/cases/${caseId}/orders/prepare`,
      cookies.issuer!,
      {
        applicationId: appRow.id,
        decision: "Admitted to bail on personal bond (synthetic demo order).",
        conditions: ["Appear on every date"],
        bondAmountInr: 10000,
        orderDate: today(),
      },
    );
    const pdf = new Uint8Array(await (await fetch(`${API}/orders/${prep.orderId}/pdf`, { headers: { cookie: cookies.issuer! } })).arrayBuffer());
    expect(hashBytes(pdf)).toBe(prep.pdfHash);
    const attestTx = await sendRegistryTx({
      method: "attestOrder",
      args: [caseId, prep.chainAppId, prep.orderId, prep.structuredHash, hashBytes(pdf)],
      role: "ISSUER_ROLE",
      expectedAccount: ACCOUNTS.issuer,
      onStatus: () => {},
    });
    await call(`/orders/${prep.orderId}/confirm`, cookies.issuer!, { txHash: attestTx });
    return { orderId: prep.orderId, pdf };
  }

  async function prisonStep(caseId: string, milestone: string, orderId: string | null) {
    const { sendRegistryTx } = await import("./wallet");
    activeAccount = PRISON;
    const prep = await call<{ milestoneId: number; orderId: string; milestoneIndex: number; evidenceCommitment: string }>(
      `/cases/${caseId}/milestones/prepare`,
      cookies.prison!,
      { milestone, orderId, note: "demo", date: today() },
    );
    const txHash = await sendRegistryTx({
      method: "attestMilestone",
      args: [caseId, prep.orderId, prep.milestoneIndex, prep.evidenceCommitment],
      role: "PRISON_ROLE",
      expectedAccount: PRISON,
      onStatus: () => {},
    });
    await call(`/milestones/${prep.milestoneId}/confirm`, cookies.prison!, { txHash });
  }

  it("completes the journey; /verify accepts the original PDF and rejects a modified one", async () => {
    const { verify } = await import("./verify");
    const { readRegistry } = await import("./deployment");
    const { hashBytes } = await import("./hash");
    const caseId = await newReachedCase(cookies.caseworker!, `SYN/JOURNEY/${Date.now()}`);

    await prisonStep(caseId, "SUPERINTENDENT_APPLICATION", null);
    const { orderId, pdf } = await fileAndAttest(caseId);
    const registry = readRegistry();

    // QR lookup only: record found, file not yet checked.
    const qr = await verify(registry, { orderId });
    expect(qr.kind).toBe("order");
    if (qr.kind === "order") {
      expect(qr.fileMatches).toBeNull();
      expect(qr.issuerAuthorised).toBe(true);
      expect(qr.order.status).toBe("ACTIVE");
    }
    // Original bytes pass, with and without the QR order ID.
    const ok = await verify(registry, { fileHash: hashBytes(pdf), orderId });
    expect(ok.kind === "order" && ok.fileMatches).toBe(true);
    const ok2 = await verify(registry, { fileHash: hashBytes(pdf) });
    expect(ok2.kind === "order" && ok2.fileMatches).toBe(true);
    // One modified byte fails.
    const altered = Uint8Array.from(pdf);
    altered[200] = altered[200]! ^ 0x01;
    expect((await verify(registry, { fileHash: hashBytes(altered) })).kind).toBe("not-registered");
    const alteredWithQr = await verify(registry, { fileHash: hashBytes(altered), orderId });
    expect(alteredWithQr.kind === "order" && alteredWithQr.fileMatches).toBe(false);

    await prisonStep(caseId, "ORDER_RECEIVED_BY_PRISON", orderId);
    await prisonStep(caseId, "RELEASE_ACKNOWLEDGED", orderId);
    const final = await verify(registry, { orderId });
    expect(final.kind === "order" && final.milestones.map((m) => m.milestone)).toEqual([
      "THRESHOLD_FLAGGED",
      "SUPERINTENDENT_APPLICATION",
      "APPLICATION_FILED",
      "ORDER_ATTESTED",
      "ORDER_RECEIVED_BY_PRISON",
      "RELEASE_ACKNOWLEDGED",
    ]);
  }, 120_000);

  it("a revoked order shows REVOKED and blocks prison acknowledgement in pre-flight", async () => {
    const { verify } = await import("./verify");
    const { readRegistry } = await import("./deployment");
    const { sendRegistryTx } = await import("./wallet");
    const caseId = await newReachedCase(cookies.caseworker!, `SYN/REVOKED/${Date.now()}`);
    const { orderId } = await fileAndAttest(caseId);

    activeAccount = ACCOUNTS.issuer;
    const { reasonCommitment } = await call<{ reasonCommitment: string }>(`/orders/${orderId}/revoke/prepare`, cookies.issuer!, {
      reason: "Issued on the wrong application (demo)",
    });
    const revokeTx = await sendRegistryTx({
      method: "revokeOrder",
      args: [orderId, reasonCommitment],
      role: "ISSUER_ROLE",
      expectedAccount: ACCOUNTS.issuer,
      onStatus: () => {},
    });
    await call(`/orders/${orderId}/revoke/confirm`, cookies.issuer!, { txHash: revokeTx });

    const v = await verify(readRegistry(), { orderId });
    expect(v.kind === "order" && v.order.status).toBe("REVOKED");

    // Even bypassing the server's own check, the wallet pre-flight refuses with a plain error.
    activeAccount = PRISON;
    await expect(
      sendRegistryTx({
        method: "attestMilestone",
        args: [caseId, orderId, 5, "0x" + "11".repeat(32)],
        role: "PRISON_ROLE",
        expectedAccount: PRISON,
        onStatus: () => {},
      }),
    ).rejects.toThrow(/not ACTIVE/);
  }, 120_000);

  it("supersedes an order; /verify shows the old order SUPERSEDED with a link to the new one", async () => {
    const { verify } = await import("./verify");
    const { readRegistry } = await import("./deployment");
    const { sendRegistryTx } = await import("./wallet");
    const { hashBytes } = await import("./hash");
    const caseId = await newReachedCase(cookies.caseworker!, `SYN/SUPERSEDE/${Date.now()}`);
    const { orderId, pdf: oldPdf } = await fileAndAttest(caseId);

    activeAccount = ACCOUNTS.issuer;
    const prep = await call<{ orderId: string; structuredHash: string; pdfHash: string; reasonCommitment: string }>(
      `/orders/${orderId}/supersede/prepare`,
      cookies.issuer!,
      { decision: "Corrected order with revised bond (synthetic demo).", conditions: [], bondAmountInr: 15000, orderDate: today(), reason: "Bond corrected (demo)" },
    );
    const newPdf = new Uint8Array(await (await fetch(`${API}/orders/${prep.orderId}/pdf`, { headers: { cookie: cookies.issuer! } })).arrayBuffer());
    const txHash = await sendRegistryTx({
      method: "supersedeOrder",
      args: [orderId, prep.orderId, prep.structuredHash, hashBytes(newPdf), prep.reasonCommitment],
      role: "ISSUER_ROLE",
      expectedAccount: ACCOUNTS.issuer,
      onStatus: () => {},
    });
    await call(`/orders/${prep.orderId}/supersede/confirm`, cookies.issuer!, { txHash });

    const registry = readRegistry();
    const oldV = await verify(registry, { fileHash: hashBytes(oldPdf) });
    expect(oldV.kind === "order" && oldV.order.status).toBe("SUPERSEDED");
    expect(oldV.kind === "order" && oldV.order.supersededBy).toBe(prep.orderId);
    const newV = await verify(registry, { fileHash: hashBytes(newPdf) });
    expect(newV.kind === "order" && newV.order.status).toBe("ACTIVE");
    expect(newV.kind === "order" && newV.order.supersedes).toBe(orderId);
  }, 120_000);

  it("distinguishes an unreachable RPC from 'not registered'", async () => {
    const { verify } = await import("./verify");
    const { Contract, JsonRpcProvider } = await import("ethers");
    const d = JSON.parse(readFileSync(deploymentFile, "utf8"));
    const dead = new Contract(d.address, d.abi, new JsonRpcProvider("http://127.0.0.1:9", d.chainId, { staticNetwork: true }));
    expect((await verify(dead, { fileHash: "0x" + "22".repeat(32) })).kind).toBe("rpc-unavailable");
    expect((await verify(null, { fileHash: "0x" + "22".repeat(32) })).kind).toBe("no-registry");
  }, 30_000);

  it("release clock aggregates events without personal data", async () => {
    const { loadReleaseClock } = await import("./releaseClock");
    const { readRegistry, publicProvider } = await import("./deployment");
    const d = JSON.parse(readFileSync(deploymentFile, "utf8"));
    const data = await loadReleaseClock(readRegistry()!, publicProvider()!, d.deploymentBlock, { chunk: 5 });
    expect(data.totals.casesTracked).toBeGreaterThanOrEqual(3);
    expect(data.totals.releasesAcknowledged).toBeGreaterThanOrEqual(1);
    expect(data.totals.ordersRevoked).toBeGreaterThanOrEqual(1);
    expect(data.rows.length).toBe(data.totals.casesTracked);
    expect(JSON.stringify(data)).not.toMatch(/Demo Journey|synthetic|bns-|SYN\//);
  }, 60_000);
});
