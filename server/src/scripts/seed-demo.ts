/**
 * Seed the synthetic demo: DB and chain agree because every step goes through the
 * same service functions the API uses, and every role action is a real signed tx.
 *
 *   npm run seed            # add demo cases
 *   npm run seed -- --reset # delete the local DB + stored PDFs first
 *
 * Run it while the API server is STOPPED (both use the registrar wallet's nonce).
 * Local chain: role wallets default to Hardhat accounts #1-#3.
 * Sepolia: set SEED_LAWYER_PRIVATE_KEY, SEED_ISSUER_PRIVATE_KEY, SEED_PRISON_PRIVATE_KEY
 * (wallets that hold the roles and have test ETH). Keys are never printed.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Contract, NonceManager, Wallet, getAddress, type InterfaceAbi } from "ethers";
import { loadConfig } from "../config.js";
import { bootstrap } from "../bootstrap.js";
import type { Role, User } from "../auth.js";
import { addDays, todayIso } from "../screening/dates.js";
import { createCase, drainAnchorJobs, getCaseRow, liveScreening, type CaseCreateInput } from "../services/cases.js";
import {
  confirmMilestone,
  confirmOrder,
  confirmRevoke,
  draftApplicationPdf,
  prepareMilestone,
  prepareOrder,
  prepareRevoke,
  readStored,
  recordFiledApplication,
  getOrderRow,
} from "../services/documents.js";
import { verifyUrl } from "../pdf/order.js";
import { hashBytes } from "../lib/hashing.js";
import { statusHeadline } from "../screening/engine.js";
import { waitForReceipt } from "../chain.js";

const HARDHAT_KEYS = {
  lawyer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  issuer: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  prison: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
};

const config = loadConfig();
if (process.argv.includes("--reset")) {
  for (const f of [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`]) if (existsSync(f)) rmSync(f);
  if (existsSync(config.storageDir)) rmSync(config.storageDir, { recursive: true });
  console.log("Reset local database and stored PDFs.");
}
const ctx = bootstrap(config);
const today = todayIso();

function user(username: Role): User {
  const r = ctx.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as {
    id: number;
    username: string;
    role: Role;
    display_name: string;
    wallet_address: string | null;
  };
  return { id: r.id, username: r.username, role: r.role, displayName: r.display_name, walletAddress: r.wallet_address };
}

const users = { caseworker: user("caseworker"), lawyer: user("lawyer"), issuer: user("issuer"), prison: user("prison") };

/** Custody that has lasted `days` days (inclusive) as of today. */
const ongoing = (days: number) => [{ start: addDays(today, -(days - 1)), end: null }];

const base = { court: "Demo Sessions Court, Synthetic District", stage: "Trial — prosecution evidence", excludedDays: 0, excludedNote: "" };

const CASES: Record<string, CaseCreateInput> = {
  hero: {
    ...base,
    personName: "Ravi K. (synthetic)",
    age: 34,
    caseRef: "SYN/2024/0141",
    offenceId: "bns-303-2-first", // max 1095 days; one-half = 548
    custodyPeriods: ongoing(588), // threshold reached 40 days ago
    previousConviction: "yes",
    otherPendingCases: "no",
  },
  approaching: {
    ...base,
    personName: "Meena S. (synthetic)",
    age: 27,
    caseRef: "SYN/2024/0233",
    offenceId: "bns-318-4", // max 2555 days; one-third = 852
    custodyPeriods: ongoing(800), // 52 days to go
    previousConviction: "no",
    otherPendingCases: "no",
    stage: "Charges framed",
  },
  multiple: {
    ...base,
    personName: "Arjun P. (synthetic)",
    age: 41,
    caseRef: "SYN/2023/0098",
    offenceId: "bns-305",
    custodyPeriods: ongoing(1400),
    previousConviction: "unknown",
    otherPendingCases: "yes", // s.479(2) -> specialist review
  },
  life: {
    ...base,
    personName: "Imran H. (synthetic)",
    age: 38,
    caseRef: "SYN/2023/0012",
    offenceId: "bns-103-1", // death or life -> outside the rule
    custodyPeriods: ongoing(900),
    previousConviction: "no",
    otherPendingCases: "no",
  },
  journey: {
    ...base,
    personName: "Lakshmi D. (synthetic)",
    age: 45,
    caseRef: "SYN/2024/0057",
    offenceId: "bns-316-2", // max 1825 days; one-third = 609
    custodyPeriods: [
      { start: addDays(today, -760), end: addDays(today, -701) }, // 60 days, then released on interim bail
      { start: addDays(today, -660), end: null }, // re-arrested: 661 days
    ],
    previousConviction: "no",
    otherPendingCases: "no",
    excludedDays: 12,
    excludedNote: "Adjournments sought by the defence (synthetic)",
  },
  revoked: {
    ...base,
    personName: "Suresh N. (synthetic)",
    age: 30,
    caseRef: "SYN/2024/0302",
    offenceId: "bns-351-2", // max 730 days; one-half = 365
    custodyPeriods: ongoing(380), // threshold reached 15 days ago (keeps the hero case first in the queue)
    previousConviction: "unknown",
    otherPendingCases: "no",
  },
};

async function main() {
  console.log(ctx.chain ? `Seeding on chainId ${ctx.chain.chainId}, registry ${ctx.chain.address}` : "Seeding in OFF-CHAIN mode (DB only)");

  const ids: Record<string, string> = {};
  for (const [key, input] of Object.entries(CASES)) {
    ids[key] = createCase(ctx, input, users.caseworker);
    await drainAnchorJobs();
    const row = getCaseRow(ctx, ids[key]!);
    if (ctx.chain && row.chain_status !== "anchored") throw new Error(`Anchoring failed for ${key}: ${row.chain_error}`);
    console.log(`  ${key.padEnd(12)} ${row.case_ref}  ${statusHeadline(liveScreening(ctx, row))}`);
  }

  if (!ctx.chain) {
    console.log("\nOff-chain mode: skipped wallet-signed steps (filing, orders, prison milestones).");
    return;
  }

  // ---- role wallets
  const isLocal = ctx.chain.chainId === 31337;
  const key = (name: keyof typeof HARDHAT_KEYS, env: string) => {
    const k = isLocal ? HARDHAT_KEYS[name] : process.env[env] || "";
    if (!k) throw new Error(`${env} is required to seed on chain ${ctx.chain!.chainId}`);
    return k;
  };
  const abi = ctx.chain.config.deployment.abi as InterfaceAbi;
  const wallets = {
    lawyer: new NonceManager(new Wallet(key("lawyer", "SEED_LAWYER_PRIVATE_KEY"), ctx.chain.provider)),
    issuer: new NonceManager(new Wallet(key("issuer", "SEED_ISSUER_PRIVATE_KEY"), ctx.chain.provider)),
    prison: new NonceManager(new Wallet(key("prison", "SEED_PRISON_PRIVATE_KEY"), ctx.chain.provider)),
  };
  for (const [name, w] of Object.entries(wallets)) {
    const addr = getAddress(await w.getAddress());
    const mapped = users[name as keyof typeof wallets].walletAddress;
    if (!mapped || getAddress(mapped) !== addr) {
      throw new Error(`The ${name} seed wallet ${addr} is not the wallet mapped to the demo ${name} user (${mapped}). Set DEMO_${name.toUpperCase()}_WALLET.`);
    }
  }
  const as = (w: NonceManager) => new Contract(ctx.chain!.address, abi, w);
  const send = async (w: NonceManager, method: string, args: unknown[]) => {
    const tx = await as(w).getFunction(method)(...args);
    const receipt = await waitForReceipt(ctx.chain!.provider, tx.hash as string);
    if (receipt.status !== 1) throw new Error(`${method} transaction failed`);
    return tx.hash as string;
  };

  const prisonStep = async (caseId: string, milestone: "SUPERINTENDENT_APPLICATION" | "ORDER_RECEIVED_BY_PRISON" | "RELEASE_ACKNOWLEDGED", orderId: string | null, note: string) => {
    const p = prepareMilestone(ctx, caseId, users.prison, { milestone, orderId, note, date: today });
    const txHash = await send(wallets.prison, "attestMilestone", [caseId, p.orderId, p.milestoneIndex, p.evidenceCommitment]);
    await confirmMilestone(ctx, p.milestoneId, users.prison, txHash);
  };

  const fileAndOrder = async (caseId: string) => {
    const pdf = await draftApplicationPdf(ctx, caseId, users.lawyer);
    const fileTx = await send(wallets.lawyer, "fileApplication", [caseId, hashBytes(pdf)]);
    const app = await recordFiledApplication(ctx, caseId, users.lawyer, fileTx, pdf);
    const prep = await prepareOrder(ctx, caseId, users.issuer, {
      applicationId: app.id,
      decision:
        "Upon consideration of the application under Section 479 of the Bharatiya Nagarik Suraksha Sanhita, 2023, and the record of detention, the applicant is admitted to bail on executing a personal bond (synthetic demo order).",
      conditions: ["Shall appear before the Court on every date of hearing.", "Shall not leave the district without prior permission of the Court."],
      bondAmountInr: 10000,
      orderDate: today,
    });
    const attestTx = await send(wallets.issuer, "attestOrder", [caseId, prep.chainAppId, prep.orderId, prep.structuredHash, prep.pdfHash]);
    await confirmOrder(ctx, prep.orderId, users.issuer, attestTx);
    return prep.orderId;
  };

  // ---- case 5: full journey (b and c in "lawyer first" order to show non-linearity)
  console.log("\nFull journey:");
  const journeyOrder = await fileAndOrder(ids.journey!);
  console.log("  application filed, order attested");
  await prisonStep(ids.journey!, "SUPERINTENDENT_APPLICATION", null, "Written application under s.479(3) sent to the Court (synthetic)");
  await prisonStep(ids.journey!, "ORDER_RECEIVED_BY_PRISON", journeyOrder, "Order entered in inward register (synthetic)");
  await prisonStep(ids.journey!, "RELEASE_ACKNOWLEDGED", journeyOrder, "Released on executing bond (synthetic)");
  console.log("  superintendent application, receipt, release acknowledged");

  // ---- revoked order for the verify demo
  const revokedOrder = await fileAndOrder(ids.revoked!);
  const rv = prepareRevoke(ctx, revokedOrder, users.issuer, "Order issued against the wrong application (synthetic demo)");
  const rvTx = await send(wallets.issuer, "revokeOrder", [revokedOrder, rv.reasonCommitment]);
  await confirmRevoke(ctx, revokedOrder, users.issuer, rvTx);
  console.log("Revoked order prepared for the /verify demo.");

  // ---- demo files for /verify: original order PDF and a one-byte-modified copy
  const outDir = path.join(config.storageDir, "demo-files");
  mkdirSync(outDir, { recursive: true });
  const original = readStored(ctx, getOrderRow(ctx, journeyOrder).pdf_path);
  const tampered = Buffer.from(original);
  const at = Math.floor(tampered.length / 2);
  tampered[at] = tampered[at]! ^ 0x01;
  writeFileSync(path.join(outDir, "order-original.pdf"), original);
  writeFileSync(path.join(outDir, "order-modified-one-byte.pdf"), tampered);
  writeFileSync(path.join(outDir, "order-revoked.pdf"), readStored(ctx, getOrderRow(ctx, revokedOrder).pdf_path));

  console.log("\nDemo links:");
  console.log(`  Active order:  ${verifyUrl(config.publicWebUrl, journeyOrder)}`);
  console.log(`  Revoked order: ${verifyUrl(config.publicWebUrl, revokedOrder)}`);
  console.log(`  Demo PDFs for /verify: ${outDir}`);
  console.log(`  Hero case:     ${config.publicWebUrl}/cases/${ids.hero}`);
}

main()
  .then(() => {
    ctx.db.close();
    process.exit(0);
  })
  .catch((err) => {
    console.error(`Seed failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
