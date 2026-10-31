/**
 * End-to-end: real Hardhat node + deployed BailRegistry + server API + wallet-signed txs.
 * Exercises the full Release Tracker journey and its failure modes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Contract, ContractFactory, JsonRpcProvider, NonceManager, Wallet, keccak256, type InterfaceAbi } from "ethers";
import type { Express } from "express";
import { createApp } from "../src/app.js";
import { drainAnchorJobs } from "../src/services/cases.js";
import { REPO_ROOT } from "../src/config.js";
import { caseInput, login, testCtx } from "./helpers.js";

const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts");
const ARTIFACT = path.join(CONTRACTS_DIR, "artifacts", "contracts", "BailRegistry.sol", "BailRegistry.json");

// Well-known Hardhat development keys (accounts #0-#4). Never use on a real network.
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
];

let node: ChildProcess;
let app: Express;
let registry: Contract;
let provider: JsonRpcProvider;
let abi: InterfaceAbi;
const signer = (i: number) => new NonceManager(new Wallet(KEYS[i]!, provider));
let lawyerW: NonceManager, issuerW: NonceManager, prisonW: NonceManager, rogueW: NonceManager;

async function waitForRpc() {
  for (let i = 0; i < 60; i++) {
    try {
      await new JsonRpcProvider(RPC).getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("hardhat node did not start");
}

const binary = (res: NodeJS.ReadableStream & { on: Function }, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

const as = (w: NonceManager) => registry.connect(w) as Contract;

beforeAll(async () => {
  if (!existsSync(ARTIFACT)) execSync("npx hardhat compile", { cwd: CONTRACTS_DIR, stdio: "ignore" });
  node = spawn(`npx hardhat node --port ${PORT}`, { cwd: CONTRACTS_DIR, shell: true, stdio: "ignore" });
  await waitForRpc();
  provider = new JsonRpcProvider(RPC, 31337, { staticNetwork: true });
  const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: InterfaceAbi; bytecode: string };
  abi = artifact.abi;
  const deployer = signer(0);
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const deployed = await factory.deploy(await deployer.getAddress());
  await deployed.waitForDeployment();
  const address = await deployed.getAddress();
  registry = new Contract(address, artifact.abi, provider);
  const deploymentBlock = (await deployed.deploymentTransaction()!.wait())!.blockNumber;

  lawyerW = signer(1);
  issuerW = signer(2);
  prisonW = signer(3);
  rogueW = signer(4);
  const admin = as(deployer);
  const grant = async (role: string, w: NonceManager) =>
    (await admin.getFunction("grantRole")(await registry.getFunction(role)(), await w.getAddress())).wait();
  await grant("REGISTRAR_ROLE", deployer);
  await grant("LAWYER_ROLE", lawyerW);
  await grant("ISSUER_ROLE", issuerW);
  await grant("PRISON_ROLE", prisonW);
  await grant("PRISON_ROLE", rogueW); // a second prison-role wallet NOT mapped to the demo prison user

  const ctx = testCtx({
    chain: {
      rpcUrl: RPC,
      registrarKey: KEYS[0]!,
      deployment: {
        contract: "BailRegistry",
        network: "e2e",
        chainId: 31337,
        address,
        deploymentBlock,
        explorerUrl: null,
        publicRpcUrl: RPC,
        abi: artifact.abi as unknown[],
      },
    },
    offChainReason: null,
    demoWallets: {
      lawyer: await lawyerW.getAddress(),
      issuer: await issuerW.getAddress(),
      prison: await prisonW.getAddress(),
    },
  });
  app = createApp(ctx);
}, 180_000);

afterAll(() => {
  if (node?.pid) {
    try {
      if (process.platform === "win32") execSync(`taskkill /pid ${node.pid} /T /F`, { stdio: "ignore" });
      else process.kill(-node.pid);
    } catch {
      node.kill();
    }
  }
});

async function createAnchoredCase(days: number, overrides: Record<string, unknown> = {}) {
  const cw = await login(app, "caseworker");
  const res = await cw.post("/api/cases").send(caseInput(days, overrides));
  expect(res.status).toBe(201);
  await drainAnchorJobs();
  const detail = (await cw.get(`/api/cases/${res.body.case.id}`)).body;
  return detail;
}

async function fileApplication(caseId: string) {
  const lawyer = await login(app, "lawyer");
  const draft = await lawyer.get(`/api/cases/${caseId}/application-draft.pdf`).buffer(true).parse(binary);
  expect(draft.status).toBe(200);
  const bytes = draft.body as Buffer;
  const pdfHash = keccak256(bytes);
  const tx = await as(lawyerW).getFunction("fileApplication")(caseId, pdfHash);
  await tx.wait();
  return { lawyer, bytes, pdfHash, txHash: tx.hash as string };
}

async function attestOrder(caseId: string, applicationId: number) {
  const issuer = await login(app, "issuer");
  const prep = await issuer.post(`/api/cases/${caseId}/orders/prepare`).send({
    applicationId,
    decision: "Upon consideration of the application under s.479 BNSS, the applicant is admitted to bail on bond (synthetic demo).",
    conditions: ["Appear on every date of hearing", "Do not leave the district without permission"],
    bondAmountInr: 10000,
    orderDate: "2026-10-30",
  });
  expect(prep.status).toBe(201);
  const pdf = await issuer.get(`/api/orders/${prep.body.orderId}/pdf`).buffer(true).parse(binary);
  expect(keccak256(pdf.body as Buffer)).toBe(prep.body.pdfHash); // browser-side check of final bytes
  expect(prep.body.structuredHash).not.toBe(prep.body.pdfHash);
  const tx = await as(issuerW).getFunction("attestOrder")(
    caseId,
    prep.body.chainAppId,
    prep.body.orderId,
    prep.body.structuredHash,
    prep.body.pdfHash,
  );
  await tx.wait();
  const confirm = await issuer.post(`/api/orders/${prep.body.orderId}/confirm`).send({ txHash: tx.hash });
  expect(confirm.status).toBe(200);
  expect(confirm.body.order.status).toBe("ACTIVE");
  return { orderId: prep.body.orderId as string, pdfHash: prep.body.pdfHash as string, pdf: pdf.body as Buffer, issuer };
}

async function prisonMilestone(caseId: string, milestone: string, orderId: string | null, w = prisonW) {
  const prison = await login(app, "prison");
  const prep = await prison
    .post(`/api/cases/${caseId}/milestones/prepare`)
    .send({ milestone, orderId, note: "Recorded in demo", date: "2026-10-30" });
  if (prep.status !== 201) return { prep, confirm: null };
  const tx = await as(w).getFunction("attestMilestone")(
    caseId,
    prep.body.orderId,
    prep.body.milestoneIndex,
    prep.body.evidenceCommitment,
  );
  await tx.wait();
  const confirm = await prison.post(`/api/milestones/${prep.body.milestoneId}/confirm`).send({ txHash: tx.hash });
  return { prep, confirm };
}

describe("end-to-end on a local chain", () => {
  it("registers, anchors and flags a case that reached the threshold", async () => {
    const d = await createAnchoredCase(588);
    expect(d.case.chainStatus).toBe("anchored");
    expect(d.case.registerTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d.snapshots[0].txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d.workflow.steps[0]).toMatchObject({ milestone: "THRESHOLD_FLAGGED", state: "done" });
    expect(d.workflow.steps[0].receipt.offChain).toBe(false);

    const onChain = await registry.getFunction("getCase")(d.case.id);
    expect(onChain.exists).toBe(true);
    expect(onChain.recordCommitment).toBe(d.case.recordCommitment);
    expect(onChain.screeningCommitment).toBe(d.snapshots[0].commitment);
    const ms = await registry.getFunction("getMilestones")(d.case.id);
    expect(ms.map((m: { milestone: bigint }) => Number(m.milestone))).toEqual([1]);
  }, 120_000);

  it("does not flag a case below the threshold", async () => {
    const d = await createAnchoredCase(100);
    expect(d.case.chainStatus).toBe("anchored");
    expect(await registry.getFunction("getMilestones")(d.case.id)).toHaveLength(0);
  }, 120_000);

  it("runs the full journey through RELEASE_ACKNOWLEDGED", async () => {
    const d = await createAnchoredCase(588, { caseRef: "SYN/E2E/FULL" });
    const caseId = d.case.id as string;

    // Prison records the s.479(3) application. A different prison-role wallet is refused.
    const rogue = await prisonMilestone(caseId, "SUPERINTENDENT_APPLICATION", null, rogueW);
    expect(rogue.confirm!.status).toBe(403);
    expect(rogue.confirm!.body.error).toMatch(/different wallet/);
    // The rogue tx already consumed the on-chain once-only slot; the mapped wallet is now rejected by the contract.
    // Use a fresh case for the happy path of this milestone.
    const d2 = await createAnchoredCase(588, { caseRef: "SYN/E2E/FULL-2" });
    const id2 = d2.case.id as string;
    const sup = await prisonMilestone(id2, "SUPERINTENDENT_APPLICATION", null);
    expect(sup.confirm!.status).toBe(200);
    const dup = await prisonMilestone(id2, "SUPERINTENDENT_APPLICATION", null);
    expect(dup.prep.status).toBe(409);

    // Lawyer files: altered bytes are rejected, exact bytes accepted.
    const filed = await fileApplication(id2);
    const altered = Buffer.from(filed.bytes);
    altered[altered.length - 10] = altered[altered.length - 10]! ^ 0x01;
    const bad = await filed.lawyer
      .post(`/api/cases/${id2}/applications?txHash=${filed.txHash}`)
      .set("content-type", "application/pdf")
      .send(altered);
    expect(bad.status).toBe(409);
    expect(bad.body.error).toMatch(/do not match/);
    const good = await filed.lawyer
      .post(`/api/cases/${id2}/applications?txHash=${filed.txHash}`)
      .set("content-type", "application/pdf")
      .send(filed.bytes);
    expect(good.status).toBe(201);
    const replay = await filed.lawyer
      .post(`/api/cases/${id2}/applications?txHash=${filed.txHash}`)
      .set("content-type", "application/pdf")
      .send(filed.bytes);
    expect(replay.status).toBe(409);

    // Release cannot be acknowledged before an order exists / is received.
    const early = await prisonMilestone(id2, "RELEASE_ACKNOWLEDGED", null);
    expect(early.prep.status).toBe(400);

    // Issuer attests the order (PDF with QR hashed after rendering).
    const order = await attestOrder(id2, good.body.application.id);
    const [kind, id] = await registry.getFunction("verifyDocument")(order.pdfHash);
    expect(Number(kind)).toBe(2); // ORDER_PDF
    expect(id).toBe(order.orderId);

    const tooEarly = await prisonMilestone(id2, "RELEASE_ACKNOWLEDGED", order.orderId);
    expect(tooEarly.prep.status).toBe(409);
    expect(tooEarly.prep.body.error).toMatch(/receipt/);

    const rcv = await prisonMilestone(id2, "ORDER_RECEIVED_BY_PRISON", order.orderId);
    expect(rcv.confirm!.status).toBe(200);
    const rel = await prisonMilestone(id2, "RELEASE_ACKNOWLEDGED", order.orderId);
    expect(rel.confirm!.status).toBe(200);

    const cw = await login(app, "caseworker");
    const final = (await cw.get(`/api/cases/${id2}`)).body;
    expect(final.workflow.steps.map((s: { state: string }) => s.state)).toEqual(["done", "done", "done", "done", "done", "done"]);
    expect(final.workflow.nextActions).toHaveLength(0);
    for (const s of final.workflow.steps) expect(s.receipt.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const ms = await registry.getFunction("getMilestones")(id2);
    expect(ms.map((m: { milestone: bigint }) => Number(m.milestone))).toEqual([1, 2, 3, 4, 5, 6]);
  }, 180_000);

  it("revocation blocks prison acknowledgements and keeps history", async () => {
    const d = await createAnchoredCase(588, { caseRef: "SYN/E2E/REVOKE" });
    const caseId = d.case.id as string;
    const filed = await fileApplication(caseId);
    const up = await filed.lawyer
      .post(`/api/cases/${caseId}/applications?txHash=${filed.txHash}`)
      .set("content-type", "application/pdf")
      .send(filed.bytes);
    expect(up.status).toBe(201);
    const order = await attestOrder(caseId, up.body.application.id);

    const prep = await order.issuer.post(`/api/orders/${order.orderId}/revoke/prepare`).send({ reason: "Order issued on incorrect application (demo)" });
    expect(prep.status).toBe(200);
    const tx = await as(issuerW).getFunction("revokeOrder")(order.orderId, prep.body.reasonCommitment);
    await tx.wait();
    const conf = await order.issuer.post(`/api/orders/${order.orderId}/revoke/confirm`).send({ txHash: tx.hash });
    expect(conf.status).toBe(200);
    expect(conf.body.order.status).toBe("REVOKED");

    const rcv = await prisonMilestone(caseId, "ORDER_RECEIVED_BY_PRISON", order.orderId);
    expect(rcv.prep.status).toBe(409);
    expect(rcv.prep.body.error).toMatch(/REVOKED/);

    const onChain = await registry.getFunction("getOrder")(order.orderId);
    expect(Number(onChain.status)).toBe(2); // REVOKED
    const [kind] = await registry.getFunction("verifyDocument")(order.pdfHash);
    expect(Number(kind)).toBe(2); // still resolvable

    // A second order on the same application is refused (one order per application).
    const again = await order.issuer.post(`/api/cases/${caseId}/orders/prepare`).send({
      applicationId: up.body.application.id,
      decision: "Second attempt on the same application (synthetic).",
      orderDate: "2026-10-30",
    });
    expect(again.status).toBe(409);
  }, 180_000);

  it("rejects a confirmation whose tx was for a different event", async () => {
    const d = await createAnchoredCase(588, { caseRef: "SYN/E2E/WRONG" });
    const caseId = d.case.id as string;
    const filed = await fileApplication(caseId);
    const up = await filed.lawyer
      .post(`/api/cases/${caseId}/applications?txHash=${filed.txHash}`)
      .set("content-type", "application/pdf")
      .send(filed.bytes);
    expect(up.status).toBe(201);
    const issuer = await login(app, "issuer");
    const prep = await issuer.post(`/api/cases/${caseId}/orders/prepare`).send({
      applicationId: up.body.application.id,
      decision: "Synthetic order used to test confirmation checks.",
      orderDate: "2026-10-30",
    });
    expect(prep.status).toBe(201);
    // Submit the lawyer's filing tx as if it were the issuer's attestation.
    const res = await issuer.post(`/api/orders/${prep.body.orderId}/confirm`).send({ txHash: filed.txHash });
    expect(res.status).toBe(403);
    // And an issuer-signed tx that emitted a different event (a revocation of another order) is refused too.
    const other = await createAnchoredCase(588, { caseRef: "SYN/E2E/WRONG-2" });
    const f2 = await fileApplication(other.case.id);
    const up2 = await f2.lawyer
      .post(`/api/cases/${other.case.id}/applications?txHash=${f2.txHash}`)
      .set("content-type", "application/pdf")
      .send(f2.bytes);
    const o2 = await attestOrder(other.case.id, up2.body.application.id);
    const rv = await o2.issuer.post(`/api/orders/${o2.orderId}/revoke/prepare`).send({ reason: "Testing wrong-event confirmation" });
    const rvTx = await as(issuerW).getFunction("revokeOrder")(o2.orderId, rv.body.reasonCommitment);
    await rvTx.wait();
    const wrongEvent = await issuer.post(`/api/orders/${prep.body.orderId}/confirm`).send({ txHash: rvTx.hash });
    expect(wrongEvent.status).toBe(409);
    expect(wrongEvent.body.error).toMatch(/OrderAttested/);
    void abi;
  }, 120_000);
});
