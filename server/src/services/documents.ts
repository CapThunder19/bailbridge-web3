import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAddress } from "ethers";
import { z } from "zod";
import type { User } from "../auth.js";
import { milestoneIndex, type ChainService, type MilestoneName } from "../chain.js";
import { nowIso } from "../db.js";
import { hashBytes, hashCanonicalJson, randomBytes32 } from "../lib/hashing.js";
import { buildApplicationPdf } from "../pdf/application.js";
import { buildOrderPdf, verifyUrl, type StructuredOrder } from "../pdf/order.js";
import { commit, HttpError, type Ctx } from "./context.js";
import {
  custodyOf,
  getCaseRow,
  liveScreening,
  milestonesOf,
  offenceOf,
  type ApplicationRow,
  type MilestoneRow,
  type OrderRow,
} from "./cases.js";

const ZERO32 = "0x" + "00".repeat(32);
const eq = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

function requireChain(ctx: Ctx): ChainService {
  if (!ctx.chain) throw new HttpError(409, "Off-chain demo — no blockchain attestations. Wallet actions are disabled.");
  return ctx.chain;
}

function requireWallet(user: User): string {
  if (!user.walletAddress) throw new HttpError(403, "Your demo account has no mapped wallet address.");
  return getAddress(user.walletAddress);
}

function store(ctx: Ctx, folder: string, name: string, bytes: Uint8Array): string {
  const dir = path.join(ctx.config.storageDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), bytes);
  return path.posix.join(folder, name);
}

export function readStored(ctx: Ctx, relative: string): Buffer {
  return readFileSync(path.join(ctx.config.storageDir, relative));
}

// ---------------------------------------------------------------------------
// Lawyer: draft + filing
// ---------------------------------------------------------------------------

export async function draftApplicationPdf(ctx: Ctx, caseId: string, user: User): Promise<Uint8Array> {
  const row = getCaseRow(ctx, caseId);
  const screening = liveScreening(ctx, row);
  const offence = offenceOf(ctx, row);
  if (screening.status !== "THRESHOLD_REACHED_REVIEW_REQUIRED" || !offence) {
    throw new HttpError(409, "A s.479 draft can only be generated once the screening threshold has been reached.");
  }
  return buildApplicationPdf({
    caseId,
    personName: row.person_name,
    age: row.age,
    caseRef: row.case_ref,
    court: row.court,
    stage: row.stage,
    offence,
    custodyPeriods: custodyOf(row),
    excludedNote: row.excluded_note,
    previousConviction: row.previous_conviction,
    otherPendingCases: row.other_pending,
    screening,
    lawyerName: user.displayName,
    generatedAt: new Date(),
  });
}

/**
 * Record a filed application. The browser hashed the exact bytes, the lawyer signed
 * fileApplication(caseId, pdfHash), and now uploads the same bytes. We recompute the
 * hash, read the confirmed transaction, and check case linkage and the signer wallet.
 */
export async function recordFiledApplication(
  ctx: Ctx,
  caseId: string,
  user: User,
  txHash: string,
  bytes: Uint8Array,
): Promise<ApplicationRow> {
  const chain = requireChain(ctx);
  const wallet = requireWallet(user);
  getCaseRow(ctx, caseId);
  if (bytes.length < 5 || Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") {
    throw new HttpError(400, "The uploaded file is not a PDF.");
  }
  if (ctx.db.prepare("SELECT 1 FROM applications WHERE tx_hash = ?").get(txHash)) {
    throw new HttpError(409, "This transaction has already been recorded.");
  }
  const pdfHash = hashBytes(bytes);
  const confirmed = await chain.confirmWalletTx(txHash, "ApplicationFiled", wallet);
  const args = confirmed.event.args;
  if (!eq(args.caseId, caseId)) throw new HttpError(409, "The on-chain application belongs to a different case.");
  if (!eq(args.pdfHash, pdfHash))
    throw new HttpError(409, "The uploaded bytes do not match the hash registered on-chain.");
  if (!eq(args.lawyer, wallet)) throw new HttpError(403, "The on-chain lawyer is not your mapped wallet.");

  const appId = Number(args.appId);
  const onChain = await chain.getApplication(appId);
  if (!eq(onChain.pdfHash, pdfHash) || !eq(onChain.caseId, caseId)) {
    throw new HttpError(409, "On-chain application record does not match.");
  }

  const pdfPath = store(ctx, "applications", `${pdfHash.slice(2)}.pdf`, bytes);
  const info = ctx.db
    .prepare(
      `INSERT INTO applications (case_id, chain_app_id, pdf_hash, pdf_path, lawyer_user_id, lawyer_wallet, tx_hash, block_number, chain_timestamp, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(caseId, appId, pdfHash, pdfPath, user.id, wallet.toLowerCase(), confirmed.txHash, confirmed.blockNumber, confirmed.timestamp, nowIso());
  return ctx.db.prepare("SELECT * FROM applications WHERE id = ?").get(info.lastInsertRowid) as ApplicationRow;
}

export function getApplicationRow(ctx: Ctx, id: number): ApplicationRow {
  const row = ctx.db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as ApplicationRow | undefined;
  if (!row) throw new HttpError(404, "Application not found.");
  return row;
}

// ---------------------------------------------------------------------------
// Issuer: orders
// ---------------------------------------------------------------------------

export const orderInputSchema = z.object({
  applicationId: z.number().int().positive(),
  decision: z.string().trim().min(10).max(2000),
  conditions: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  bondAmountInr: z.number().int().min(0).max(10_000_000).nullable().default(null),
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type OrderInput = z.infer<typeof orderInputSchema>;

export function getOrderRow(ctx: Ctx, orderId: string): OrderRow {
  const row = ctx.db.prepare("SELECT * FROM orders WHERE order_id = ?").get(orderId) as OrderRow | undefined;
  if (!row) throw new HttpError(404, "Order not found.");
  return row;
}

/**
 * Prepare an order: build canonical JSON (structuredOrderHash), render the PDF
 * with its QR first, then hash the final bytes (pdfHash). Stored as PREPARED until
 * the issuer's attestOrder transaction is confirmed.
 */
export async function prepareOrder(ctx: Ctx, caseId: string, user: User, input: OrderInput) {
  requireChain(ctx);
  const wallet = requireWallet(user);
  const row = getCaseRow(ctx, caseId);
  const app = getApplicationRow(ctx, input.applicationId);
  if (app.case_id !== caseId) throw new HttpError(409, "The application belongs to a different case.");
  const existing = ctx.db
    .prepare("SELECT order_id FROM orders WHERE application_id = ? AND status != 'PREPARED'")
    .get(app.id);
  if (existing) throw new HttpError(409, "An order has already been attested on this application.");
  ctx.db.prepare("DELETE FROM orders WHERE application_id = ? AND status = 'PREPARED'").run(app.id);
  return buildPreparedOrder(ctx, caseId, app, user, wallet, input, null);
}

type OrderContent = Omit<OrderInput, "applicationId">;

/** Build canonical JSON + PDF (QR first, then hash final bytes) and store as PREPARED. */
async function buildPreparedOrder(
  ctx: Ctx,
  caseId: string,
  app: ApplicationRow,
  user: User,
  wallet: string,
  input: OrderContent,
  supersede: { oldOrderId: string; reason: string; salt: string; commitment: string } | null,
) {
  const row = getCaseRow(ctx, caseId);
  const orderId = randomBytes32();
  const structured: StructuredOrder = {
    schema: "bailbridge.order.v1",
    orderId,
    caseId,
    chainApplicationId: app.chain_app_id,
    applicationPdfHash: app.pdf_hash,
    court: row.court,
    caseRef: row.case_ref,
    applicantName: row.person_name,
    orderDate: input.orderDate,
    decision: input.decision,
    conditions: input.conditions,
    bondAmountInr: input.bondAmountInr,
    issuerName: user.displayName,
    issuerWallet: wallet,
    legalProvision: "s.479 Bharatiya Nagarik Suraksha Sanhita, 2023",
    synthetic: true,
    ...(supersede ? { supersedes: supersede.oldOrderId } : {}),
  };
  const structuredHash = hashCanonicalJson(structured);
  const url = verifyUrl(ctx.config.publicWebUrl, orderId);
  const pdf = await buildOrderPdf(structured, structuredHash, url);
  const pdfHash = hashBytes(pdf); // hash of the FINAL bytes (QR already embedded)
  const pdfPath = store(ctx, "orders", `${orderId.slice(2)}.pdf`, pdf);

  ctx.db
    .prepare(
      `INSERT INTO orders (order_id, case_id, application_id, structured_json, structured_hash, pdf_hash, pdf_path, status, issuer_user_id, issuer_wallet,
         supersedes, supersede_reason, supersede_salt, supersede_commitment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PREPARED', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      orderId,
      caseId,
      app.id,
      JSON.stringify(structured),
      structuredHash,
      pdfHash,
      pdfPath,
      user.id,
      wallet.toLowerCase(),
      supersede?.oldOrderId ?? null,
      supersede?.reason ?? null,
      supersede?.salt ?? null,
      supersede?.commitment ?? null,
      nowIso(),
    );

  return {
    orderId,
    caseId,
    chainAppId: app.chain_app_id,
    structuredHash,
    pdfHash,
    verifyUrl: url,
    ...(supersede ? { supersedes: supersede.oldOrderId, reasonCommitment: supersede.commitment } : {}),
  };
}

export const supersedeInputSchema = orderInputSchema.omit({ applicationId: true }).extend({
  reason: z.string().trim().min(5).max(500),
});
export type SupersedeInput = z.infer<typeof supersedeInputSchema>;

/**
 * Prepare a replacement for an ACTIVE order (P1). The new order is linked to the old
 * one (append-only, old -> new); the reason stays off-chain, its commitment goes on-chain.
 */
export async function prepareSupersede(ctx: Ctx, oldOrderId: string, user: User, input: SupersedeInput) {
  requireChain(ctx);
  const wallet = requireWallet(user);
  const old = getOrderRow(ctx, oldOrderId);
  if (old.status !== "ACTIVE") throw new HttpError(409, `Only an ACTIVE order can be superseded (this one is ${old.status}).`);
  const app = getApplicationRow(ctx, old.application_id);
  ctx.db.prepare("DELETE FROM orders WHERE supersedes = ? AND status = 'PREPARED'").run(oldOrderId);
  const { salt, commitment } = commit(ctx, "order.supersession", { oldOrderId, reason: input.reason, supersededBy: user.username });
  const { reason, ...content } = input;
  return buildPreparedOrder(ctx, old.case_id, app, user, wallet, content, { oldOrderId, reason, salt, commitment });
}

export async function confirmSupersede(ctx: Ctx, newOrderId: string, user: User, txHash: string) {
  const chain = requireChain(ctx);
  const wallet = requireWallet(user);
  const order = getOrderRow(ctx, newOrderId);
  if (order.status !== "PREPARED" || !order.supersedes) throw new HttpError(409, "No supersession is pending for this order.");
  if (order.issuer_user_id !== user.id) throw new HttpError(403, "Only the issuer who prepared this order can confirm it.");
  const old = getOrderRow(ctx, order.supersedes);
  if (old.status !== "ACTIVE") throw new HttpError(409, `The order being replaced is ${old.status}.`);
  const app = getApplicationRow(ctx, order.application_id);

  const confirmed = await chain.confirmWalletTx(txHash, "OrderSuperseded", wallet);
  const s = confirmed.event.args;
  if (!eq(s.oldOrderId, old.order_id) || !eq(s.newOrderId, newOrderId))
    throw new HttpError(409, "The transaction superseded a different pair of orders.");
  if (!eq(s.caseId, order.case_id)) throw new HttpError(409, "The transaction is for a different case.");
  if (!eq(s.reasonCommitment, order.supersede_commitment)) throw new HttpError(409, "Supersession reason commitment mismatch.");
  const [attested] = await chain.eventsInTx(confirmed.txHash, "OrderAttested");
  const a = attested?.args;
  if (!a || !eq(a.orderId, newOrderId)) throw new HttpError(409, "The transaction did not attest the replacement order.");
  if (Number(a.appId) !== app.chain_app_id) throw new HttpError(409, "The replacement is linked to a different application.");
  if (!eq(a.structuredOrderHash, order.structured_hash)) throw new HttpError(409, "Structured order hash mismatch.");
  if (!eq(a.pdfHash, order.pdf_hash)) throw new HttpError(409, "Order PDF hash mismatch.");
  if (!eq(a.issuer, wallet)) throw new HttpError(403, "The on-chain issuer is not your mapped wallet.");

  ctx.db.transaction(() => {
    ctx.db
      .prepare("UPDATE orders SET status = 'ACTIVE', tx_hash = ?, block_number = ?, chain_timestamp = ? WHERE order_id = ?")
      .run(confirmed.txHash, confirmed.blockNumber, confirmed.timestamp, newOrderId);
    ctx.db.prepare("UPDATE orders SET status = 'SUPERSEDED', superseded_by = ? WHERE order_id = ?").run(newOrderId, old.order_id);
  })();
  return getOrderRow(ctx, newOrderId);
}

export async function confirmOrder(ctx: Ctx, orderId: string, user: User, txHash: string) {
  const chain = requireChain(ctx);
  const wallet = requireWallet(user);
  const order = getOrderRow(ctx, orderId);
  if (order.status !== "PREPARED") throw new HttpError(409, `Order is already ${order.status}.`);
  if (order.supersedes) throw new HttpError(409, "This is a replacement order; confirm it as a supersession.");
  if (order.issuer_user_id !== user.id) throw new HttpError(403, "Only the issuer who prepared this order can confirm it.");
  const app = getApplicationRow(ctx, order.application_id);

  const confirmed = await chain.confirmWalletTx(txHash, "OrderAttested", wallet);
  const a = confirmed.event.args;
  if (!eq(a.orderId, orderId)) throw new HttpError(409, "The transaction attested a different order ID.");
  if (!eq(a.caseId, order.case_id)) throw new HttpError(409, "The transaction attested an order for a different case.");
  if (Number(a.appId) !== app.chain_app_id) throw new HttpError(409, "The transaction linked a different application.");
  if (!eq(a.structuredOrderHash, order.structured_hash)) throw new HttpError(409, "Structured order hash mismatch.");
  if (!eq(a.pdfHash, order.pdf_hash)) throw new HttpError(409, "Order PDF hash mismatch.");
  if (!eq(a.issuer, wallet)) throw new HttpError(403, "The on-chain issuer is not your mapped wallet.");

  ctx.db
    .prepare("UPDATE orders SET status = 'ACTIVE', tx_hash = ?, block_number = ?, chain_timestamp = ? WHERE order_id = ?")
    .run(confirmed.txHash, confirmed.blockNumber, confirmed.timestamp, orderId);
  return getOrderRow(ctx, orderId);
}

export function prepareRevoke(ctx: Ctx, orderId: string, user: User, reason: string) {
  requireChain(ctx);
  requireWallet(user);
  const order = getOrderRow(ctx, orderId);
  if (order.status !== "ACTIVE") throw new HttpError(409, `Only an ACTIVE order can be revoked (this one is ${order.status}).`);
  const { salt, commitment } = commit(ctx, "order.revocation", { orderId, reason, revokedBy: user.username });
  ctx.db
    .prepare("UPDATE orders SET revoke_reason = ?, revoke_salt = ?, revoke_commitment = ? WHERE order_id = ?")
    .run(reason, salt, commitment, orderId);
  return { orderId, reasonCommitment: commitment };
}

export async function confirmRevoke(ctx: Ctx, orderId: string, user: User, txHash: string) {
  const chain = requireChain(ctx);
  const wallet = requireWallet(user);
  const order = getOrderRow(ctx, orderId);
  if (order.status !== "ACTIVE" || !order.revoke_commitment) throw new HttpError(409, "No revocation is pending for this order.");
  const confirmed = await chain.confirmWalletTx(txHash, "OrderRevoked", wallet);
  const a = confirmed.event.args;
  if (!eq(a.orderId, orderId)) throw new HttpError(409, "The transaction revoked a different order.");
  if (!eq(a.reasonCommitment, order.revoke_commitment)) throw new HttpError(409, "Revocation reason commitment mismatch.");
  ctx.db
    .prepare("UPDATE orders SET status = 'REVOKED', revoke_tx = ?, revoked_at = ? WHERE order_id = ?")
    .run(confirmed.txHash, confirmed.timestamp, orderId);
  return getOrderRow(ctx, orderId);
}

// ---------------------------------------------------------------------------
// Prison: milestones
// ---------------------------------------------------------------------------

export const PRISON_MILESTONES = ["SUPERINTENDENT_APPLICATION", "ORDER_RECEIVED_BY_PRISON", "RELEASE_ACKNOWLEDGED"] as const;

export const milestoneInputSchema = z.object({
  milestone: z.enum(PRISON_MILESTONES),
  orderId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable().default(null),
  note: z.string().trim().max(500).default(""),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type MilestoneInput = z.infer<typeof milestoneInputSchema>;

/** Mirror the contract's prerequisite checks to give plain errors before a wallet prompt. */
export function prepareMilestone(ctx: Ctx, caseId: string, user: User, input: MilestoneInput) {
  requireChain(ctx);
  requireWallet(user);
  getCaseRow(ctx, caseId);
  const done = milestonesOf(ctx, caseId);
  const has = (m: MilestoneName, orderId?: string) =>
    done.some((r) => r.milestone === m && (orderId === undefined || eq(r.order_id, orderId)));

  let orderId: string | null = null;
  if (input.milestone === "SUPERINTENDENT_APPLICATION") {
    if (input.orderId) throw new HttpError(400, "The superintendent application is not linked to an order.");
    if (has("SUPERINTENDENT_APPLICATION")) throw new HttpError(409, "The superintendent application is already recorded.");
  } else {
    if (!input.orderId) throw new HttpError(400, "Select the order this acknowledgement refers to.");
    const order = getOrderRow(ctx, input.orderId);
    if (order.case_id !== caseId) throw new HttpError(409, "That order belongs to a different case.");
    if (order.status !== "ACTIVE") throw new HttpError(409, `The order is ${order.status}; only an ACTIVE order can be acknowledged.`);
    orderId = order.order_id;
    if (input.milestone === "ORDER_RECEIVED_BY_PRISON" && has("ORDER_RECEIVED_BY_PRISON", orderId))
      throw new HttpError(409, "Receipt of this order is already recorded.");
    if (input.milestone === "RELEASE_ACKNOWLEDGED") {
      if (!has("ORDER_RECEIVED_BY_PRISON", orderId)) throw new HttpError(409, "Record receipt of the order first.");
      if (has("RELEASE_ACKNOWLEDGED")) throw new HttpError(409, "Release is already acknowledged for this case.");
    }
  }

  const evidence = { caseId, milestone: input.milestone, orderId, note: input.note, date: input.date, recordedBy: user.username };
  const { salt, commitment } = commit(ctx, "milestone.evidence", evidence);
  ctx.db.prepare("DELETE FROM milestones WHERE case_id = ? AND milestone = ? AND status = 'prepared' AND actor_user_id = ?").run(
    caseId,
    input.milestone,
    user.id,
  );
  const info = ctx.db
    .prepare(
      `INSERT INTO milestones (case_id, milestone, order_id, evidence_json, evidence_salt, evidence_commitment, actor_user_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?)`,
    )
    .run(caseId, input.milestone, orderId, JSON.stringify(evidence), salt, commitment, user.id, nowIso());
  return {
    milestoneId: Number(info.lastInsertRowid),
    caseId,
    milestone: input.milestone,
    milestoneIndex: milestoneIndex(input.milestone),
    orderId: orderId ?? ZERO32,
    evidenceCommitment: commitment,
  };
}

export async function confirmMilestone(ctx: Ctx, milestoneId: number, user: User, txHash: string) {
  const chain = requireChain(ctx);
  const wallet = requireWallet(user);
  const row = ctx.db.prepare("SELECT * FROM milestones WHERE id = ?").get(milestoneId) as MilestoneRow | undefined;
  if (!row) throw new HttpError(404, "Milestone not found.");
  if (row.status !== "prepared") throw new HttpError(409, "This milestone is already recorded.");
  if (row.actor_user_id !== user.id) throw new HttpError(403, "Only the user who prepared this milestone can confirm it.");

  const confirmed = await chain.confirmWalletTx(txHash, "MilestoneAttested", wallet);
  const a = confirmed.event.args;
  if (!eq(a.caseId, row.case_id)) throw new HttpError(409, "The transaction is for a different case.");
  if (Number(a.milestone) !== milestoneIndex(row.milestone)) throw new HttpError(409, "The transaction recorded a different milestone.");
  if (!eq(a.orderId, row.order_id ?? ZERO32)) throw new HttpError(409, "The transaction references a different order.");
  if (!eq(a.evidenceCommitment, row.evidence_commitment)) throw new HttpError(409, "Evidence commitment mismatch.");
  if (!eq(a.actor, wallet)) throw new HttpError(403, "The on-chain actor is not your mapped wallet.");

  ctx.db
    .prepare(
      "UPDATE milestones SET status = 'confirmed', tx_hash = ?, block_number = ?, chain_timestamp = ?, actor_wallet = ? WHERE id = ?",
    )
    .run(confirmed.txHash, confirmed.blockNumber, confirmed.timestamp, wallet.toLowerCase(), milestoneId);
  return ctx.db.prepare("SELECT * FROM milestones WHERE id = ?").get(milestoneId) as MilestoneRow;
}
