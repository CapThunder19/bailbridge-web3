import { z } from "zod";
import type { User } from "../auth.js";
import { nowIso } from "../db.js";
import { randomBytes32 } from "../lib/hashing.js";
import {
  RULE_VERSION_NUMBER,
  screenCase,
  statusHeadline,
  validateCustodyPeriods,
  type CustodyPeriod,
  type ScreeningResult,
  type TriState,
} from "../screening/engine.js";
import { findOffence, offenceLabel, type OffenceVariant } from "../screening/offences.js";
import { commit, HttpError, type Ctx } from "./context.js";
import type { MilestoneName } from "../chain.js";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const triState = z.enum(["yes", "no", "unknown"]);

export const screeningFieldsSchema = z.object({
  offenceId: z.string().min(1, "Select an offence variant"),
  custodyPeriods: z
    .array(z.object({ start: isoDate, end: isoDate.nullable() }))
    .min(1, "Add at least one custody period")
    .max(20),
  previousConviction: triState,
  otherPendingCases: triState,
  excludedDays: z.number().int().min(0).max(100_000),
  excludedNote: z.string().max(500).default(""),
  stage: z.string().min(1).max(120),
});

export const caseCreateSchema = screeningFieldsSchema.extend({
  personName: z.string().trim().min(1, "Name is required").max(120),
  age: z.number().int().min(0).max(120).nullable(),
  caseRef: z.string().trim().min(1, "Case reference is required").max(120),
  court: z.string().trim().min(1, "Court is required").max(200),
});

export type CaseCreateInput = z.infer<typeof caseCreateSchema>;
export type ScreeningFields = z.infer<typeof screeningFieldsSchema>;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface CaseRow {
  id: string;
  person_name: string;
  age: number | null;
  case_ref: string;
  court: string;
  stage: string;
  offence_id: string;
  custody_json: string;
  previous_conviction: TriState;
  other_pending: TriState;
  excluded_days: number;
  excluded_note: string;
  record_salt: string;
  record_commitment: string;
  register_tx: string | null;
  chain_status: "offchain" | "pending" | "anchored" | "failed";
  chain_error: string | null;
  created_by: number;
  created_at: string;
  updated_at: string;
}

export interface MilestoneRow {
  id: number;
  case_id: string;
  milestone: MilestoneName;
  order_id: string | null;
  application_id: number | null;
  evidence_json: string;
  evidence_salt: string;
  evidence_commitment: string;
  actor_user_id: number | null;
  actor_wallet: string | null;
  status: "prepared" | "confirmed" | "offchain";
  tx_hash: string | null;
  block_number: number | null;
  chain_timestamp: number | null;
  created_at: string;
}

export interface ApplicationRow {
  id: number;
  case_id: string;
  chain_app_id: number;
  pdf_hash: string;
  pdf_path: string;
  lawyer_user_id: number;
  lawyer_wallet: string;
  tx_hash: string;
  block_number: number;
  chain_timestamp: number;
  created_at: string;
}

export interface OrderRow {
  order_id: string;
  case_id: string;
  application_id: number;
  structured_json: string;
  structured_hash: string;
  pdf_hash: string;
  pdf_path: string;
  status: "PREPARED" | "ACTIVE" | "REVOKED" | "SUPERSEDED";
  issuer_user_id: number;
  issuer_wallet: string | null;
  tx_hash: string | null;
  block_number: number | null;
  chain_timestamp: number | null;
  revoke_reason: string | null;
  revoke_salt: string | null;
  revoke_commitment: string | null;
  revoke_tx: string | null;
  revoked_at: number | null;
  supersedes: string | null;
  superseded_by: string | null;
  supersede_reason: string | null;
  supersede_salt: string | null;
  supersede_commitment: string | null;
  created_at: string;
}

export interface SnapshotRow {
  id: number;
  case_id: string;
  snapshot_json: string;
  salt: string;
  commitment: string;
  rule_version: number;
  tx_hash: string | null;
  created_at: string;
}

export function getCaseRow(ctx: Ctx, id: string): CaseRow {
  const row = ctx.db.prepare("SELECT * FROM cases WHERE id = ?").get(id) as CaseRow | undefined;
  if (!row) throw new HttpError(404, "Case not found.");
  return row;
}

export function custodyOf(row: CaseRow): CustodyPeriod[] {
  return JSON.parse(row.custody_json) as CustodyPeriod[];
}

export function offenceOf(ctx: Ctx, row: CaseRow): OffenceVariant | null {
  return findOffence(row.offence_id, ctx.offences);
}

/** Screening computed live as of today (the anchored snapshot records the state at save time). */
export function liveScreening(ctx: Ctx, row: CaseRow, asOf = ctx.today()): ScreeningResult {
  return screenCase({
    offence: offenceOf(ctx, row),
    custodyPeriods: custodyOf(row),
    excludedDays: row.excluded_days,
    previousConviction: row.previous_conviction,
    otherPendingCases: row.other_pending,
    asOf,
  });
}

function validateScreeningFields(ctx: Ctx, f: ScreeningFields): void {
  if (!findOffence(f.offenceId, ctx.offences)) throw new HttpError(400, "Unknown offence variant.");
  const errors = validateCustodyPeriods(f.custodyPeriods, ctx.today());
  if (errors.length) throw new HttpError(400, errors.join(" "), { custodyPeriods: errors });
}

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------

/** Identity record committed at registration (immutable thereafter). */
function recordPayload(caseId: string, i: Pick<CaseCreateInput, "personName" | "age" | "caseRef" | "court">) {
  return { caseId, personName: i.personName, age: i.age, caseRef: i.caseRef, court: i.court };
}

function snapshotPayload(caseId: string, f: ScreeningFields, result: ScreeningResult) {
  return {
    caseId,
    inputs: {
      offenceId: f.offenceId,
      custodyPeriods: f.custodyPeriods,
      excludedDays: f.excludedDays,
      excludedNote: f.excludedNote,
      previousConviction: f.previousConviction,
      otherPendingCases: f.otherPendingCases,
      stage: f.stage,
    },
    result,
  };
}

function insertSnapshot(ctx: Ctx, caseId: string, f: ScreeningFields): ScreeningResult {
  const result = screenCase({
    offence: findOffence(f.offenceId, ctx.offences),
    custodyPeriods: f.custodyPeriods,
    excludedDays: f.excludedDays,
    previousConviction: f.previousConviction,
    otherPendingCases: f.otherPendingCases,
    asOf: ctx.today(),
  });
  const payload = snapshotPayload(caseId, f, result);
  const { salt, commitment } = commit(ctx, "case.screening", payload);
  ctx.db
    .prepare(
      "INSERT INTO screening_snapshots (case_id, snapshot_json, salt, commitment, rule_version, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(caseId, JSON.stringify(payload), salt, commitment, RULE_VERSION_NUMBER, nowIso());
  return result;
}

function fieldsOf(row: CaseRow): ScreeningFields {
  return {
    offenceId: row.offence_id,
    custodyPeriods: custodyOf(row),
    previousConviction: row.previous_conviction,
    otherPendingCases: row.other_pending,
    excludedDays: row.excluded_days,
    excludedNote: row.excluded_note,
    stage: row.stage,
  };
}

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

export function createCase(ctx: Ctx, input: CaseCreateInput, user: User): string {
  validateScreeningFields(ctx, input);
  const caseId = randomBytes32();
  const { salt, commitment } = commit(ctx, "case.record", recordPayload(caseId, input));
  const now = nowIso();
  const tx = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `INSERT INTO cases (id, person_name, age, case_ref, court, stage, offence_id, custody_json,
           previous_conviction, other_pending, excluded_days, excluded_note, record_salt, record_commitment,
           chain_status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        caseId,
        input.personName,
        input.age,
        input.caseRef,
        input.court,
        input.stage,
        input.offenceId,
        JSON.stringify(input.custodyPeriods),
        input.previousConviction,
        input.otherPendingCases,
        input.excludedDays,
        input.excludedNote,
        salt,
        commitment,
        ctx.chain ? "pending" : "offchain",
        user.id,
        now,
        now,
      );
    insertSnapshot(ctx, caseId, input);
  });
  tx();
  afterScreeningChange(ctx, caseId);
  return caseId;
}

export function updateScreeningFields(ctx: Ctx, caseId: string, f: ScreeningFields): void {
  getCaseRow(ctx, caseId);
  validateScreeningFields(ctx, f);
  ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `UPDATE cases SET offence_id = ?, custody_json = ?, previous_conviction = ?, other_pending = ?,
           excluded_days = ?, excluded_note = ?, stage = ?, updated_at = ?,
           chain_status = CASE WHEN chain_status = 'offchain' THEN 'offchain' ELSE 'pending' END
         WHERE id = ?`,
      )
      .run(
        f.offenceId,
        JSON.stringify(f.custodyPeriods),
        f.previousConviction,
        f.otherPendingCases,
        f.excludedDays,
        f.excludedNote,
        f.stage,
        nowIso(),
        caseId,
      );
    insertSnapshot(ctx, caseId, f);
  })();
  afterScreeningChange(ctx, caseId);
}

// ---------------------------------------------------------------------------
// Threshold flagging + anchoring
// ---------------------------------------------------------------------------

export function milestonesOf(ctx: Ctx, caseId: string, includePrepared = false): MilestoneRow[] {
  return ctx.db
    .prepare(
      `SELECT * FROM milestones WHERE case_id = ? ${includePrepared ? "" : "AND status != 'prepared'"} ORDER BY id`,
    )
    .all(caseId) as MilestoneRow[];
}

export function hasMilestone(ctx: Ctx, caseId: string, m: MilestoneName, orderId?: string): boolean {
  return milestonesOf(ctx, caseId).some((r) => r.milestone === m && (orderId === undefined || r.order_id === orderId));
}

/** Insert a THRESHOLD_FLAGGED evidence row if the live screening has reached the threshold. */
function ensureThresholdFlagRow(ctx: Ctx, caseId: string): MilestoneRow | null {
  const row = getCaseRow(ctx, caseId);
  const s = liveScreening(ctx, row);
  if (s.status !== "THRESHOLD_REACHED_REVIEW_REQUIRED") return null;
  const existing = ctx.db
    .prepare("SELECT * FROM milestones WHERE case_id = ? AND milestone = 'THRESHOLD_FLAGGED'")
    .get(caseId) as MilestoneRow | undefined;
  if (existing) return existing;
  const latest = latestSnapshot(ctx, caseId);
  const evidence = {
    caseId,
    milestone: "THRESHOLD_FLAGGED",
    asOf: s.asOf,
    estimatedThresholdDate: s.estimatedThresholdDate,
    qualifyingDays: s.qualifyingDays,
    thresholdDays: s.thresholdDays,
    fraction: s.fraction,
    screeningCommitment: latest?.commitment ?? null,
    ruleVersion: s.ruleVersion,
  };
  const { salt, commitment } = commit(ctx, "milestone.evidence", evidence);
  const info = ctx.db
    .prepare(
      `INSERT INTO milestones (case_id, milestone, evidence_json, evidence_salt, evidence_commitment, status, created_at)
       VALUES (?, 'THRESHOLD_FLAGGED', ?, ?, ?, ?, ?)`,
    )
    .run(caseId, JSON.stringify(evidence), salt, commitment, ctx.chain ? "prepared" : "offchain", nowIso());
  return ctx.db.prepare("SELECT * FROM milestones WHERE id = ?").get(info.lastInsertRowid) as MilestoneRow;
}

export function latestSnapshot(ctx: Ctx, caseId: string): SnapshotRow | null {
  return (
    (ctx.db
      .prepare("SELECT * FROM screening_snapshots WHERE case_id = ? ORDER BY id DESC LIMIT 1")
      .get(caseId) as SnapshotRow | undefined) ?? null
  );
}

const jobs = new Map<string, Promise<void>>();

/** After a save: flag threshold if reached and (in chain mode) anchor in the background. */
export function afterScreeningChange(ctx: Ctx, caseId: string): void {
  ensureThresholdFlagRow(ctx, caseId);
  if (ctx.chain) void scheduleAnchor(ctx, caseId);
}

/** Run anchoring for a case, serialised per case. Resolves when done (never rejects). */
export function scheduleAnchor(ctx: Ctx, caseId: string): Promise<void> {
  const prev = jobs.get(caseId) ?? Promise.resolve();
  const next = prev.then(() => anchorCase(ctx, caseId)).catch(() => undefined);
  jobs.set(caseId, next);
  return next;
}

/** Wait for any in-flight anchoring jobs (used by the seed script and tests). */
export async function drainAnchorJobs(): Promise<void> {
  await Promise.all([...jobs.values()]);
}

async function anchorCase(ctx: Ctx, caseId: string): Promise<void> {
  const chain = ctx.chain;
  if (!chain) return;
  const setStatus = (status: CaseRow["chain_status"], error: string | null) =>
    ctx.db.prepare("UPDATE cases SET chain_status = ?, chain_error = ? WHERE id = ?").run(status, error, caseId);
  try {
    const row = getCaseRow(ctx, caseId);
    if (!row.register_tx) {
      if (await chain.isCaseRegistered(caseId)) {
        throw new Error("Case ID already registered on-chain by another record.");
      }
      const { txHash } = await chain.registerCase(caseId, row.record_commitment);
      ctx.db.prepare("UPDATE cases SET register_tx = ? WHERE id = ?").run(txHash, caseId);
    }
    const pending = ctx.db
      .prepare("SELECT * FROM screening_snapshots WHERE case_id = ? AND tx_hash IS NULL ORDER BY id")
      .all(caseId) as SnapshotRow[];
    for (const snap of pending) {
      const { txHash } = await chain.anchorScreening(caseId, snap.commitment, snap.rule_version);
      ctx.db.prepare("UPDATE screening_snapshots SET tx_hash = ? WHERE id = ?").run(txHash, snap.id);
    }
    const flag = ensureThresholdFlagRow(ctx, caseId);
    if (flag && flag.status === "prepared") {
      const { txHash, blockNumber } = await chain.flagThreshold(caseId, flag.evidence_commitment);
      const block = await chain.provider.getBlock(blockNumber);
      ctx.db
        .prepare(
          "UPDATE milestones SET status = 'confirmed', tx_hash = ?, block_number = ?, chain_timestamp = ?, actor_wallet = ? WHERE id = ?",
        )
        .run(txHash, blockNumber, block?.timestamp ?? null, chain.registrar.address.toLowerCase(), flag.id);
    }
    setStatus("anchored", null);
  } catch (err) {
    setStatus("failed", err instanceof Error ? err.message : String(err));
  }
}

/** Periodic sweep: flag cases whose live screening has newly reached the threshold; retry failed anchors. */
export async function sweep(ctx: Ctx): Promise<void> {
  const rows = ctx.db.prepare("SELECT id, chain_status FROM cases").all() as Pick<CaseRow, "id" | "chain_status">[];
  for (const r of rows) {
    const flag = ensureThresholdFlagRow(ctx, r.id);
    if (ctx.chain && (r.chain_status !== "anchored" || flag?.status === "prepared")) await scheduleAnchor(ctx, r.id);
  }
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export function applicationsOf(ctx: Ctx, caseId: string): ApplicationRow[] {
  return ctx.db.prepare("SELECT * FROM applications WHERE case_id = ? ORDER BY id").all(caseId) as ApplicationRow[];
}

export function ordersOf(ctx: Ctx, caseId: string, includePrepared = false): OrderRow[] {
  return ctx.db
    .prepare(`SELECT * FROM orders WHERE case_id = ? ${includePrepared ? "" : "AND status != 'PREPARED'"} ORDER BY created_at`)
    .all(caseId) as OrderRow[];
}

const DAY_MS = 86_400_000;
const daysSince = (unixSeconds: number | null, now: number) =>
  unixSeconds === null ? null : Math.max(0, Math.floor((now - unixSeconds * 1000) / DAY_MS));

export type StepState = "done" | "open" | "blocked" | "not_applicable";

export interface TimelineStep {
  milestone: MilestoneName;
  label: string;
  actorRole: "registrar" | "prison" | "lawyer" | "issuer";
  state: StepState;
  detail: string;
  receipt: null | {
    txHash: string | null;
    explorerUrl: string | null;
    wallet: string | null;
    chainTimestamp: number | null;
    recordedAt: string;
    offChain: boolean;
    orderId: string | null;
    applicationId: number | null;
  };
  /** Workflow delay in days since this step became open (not a statutory deadline). */
  openForDays: number | null;
}

export interface WorkflowState {
  steps: TimelineStep[];
  activeOrderId: string | null;
  nextActions: { role: "caseworker" | "lawyer" | "issuer" | "prison" | "specialist"; key: string; text: string; days: number | null }[];
}

export function workflowState(ctx: Ctx, row: CaseRow, screening: ScreeningResult): WorkflowState {
  const ms = milestonesOf(ctx, row.id);
  const apps = applicationsOf(ctx, row.id);
  const orders = ordersOf(ctx, row.id);
  const active = orders.find((o) => o.status === "ACTIVE") ?? null;
  const now = Date.now();
  const reached = screening.status === "THRESHOLD_REACHED_REVIEW_REQUIRED";
  const explorer = (tx: string | null) => (tx && ctx.chain ? ctx.chain.explorerTx(tx) : null);

  const receiptOf = (m: MilestoneRow | undefined): TimelineStep["receipt"] =>
    m
      ? {
          txHash: m.tx_hash,
          explorerUrl: explorer(m.tx_hash),
          wallet: m.actor_wallet,
          chainTimestamp: m.chain_timestamp,
          recordedAt: m.created_at,
          offChain: m.status === "offchain",
          orderId: m.order_id,
          applicationId: m.application_id,
        }
      : null;

  const find = (name: MilestoneName, orderId?: string | null) =>
    ms.filter((m) => m.milestone === name && (orderId === undefined || m.order_id === orderId)).at(-1);

  const flagged = find("THRESHOLD_FLAGGED");
  const sup = find("SUPERINTENDENT_APPLICATION");
  const lastApp = apps.at(-1);
  const received = active ? find("ORDER_RECEIVED_BY_PRISON", active.order_id) : undefined;
  const released = find("RELEASE_ACKNOWLEDGED");
  const thresholdDays = screening.daysSinceThreshold;

  const steps: TimelineStep[] = [
    {
      milestone: "THRESHOLD_FLAGGED",
      label: "Threshold flagged for review",
      actorRole: "registrar",
      state: flagged ? "done" : reached ? "open" : "blocked",
      detail: flagged
        ? "Screening reached the s.479 threshold; flagged by the BailBridge registrar."
        : reached
          ? "Threshold reached; flag pending."
          : statusHeadline(screening),
      receipt: receiptOf(flagged),
      openForDays: null,
    },
    {
      milestone: "SUPERINTENDENT_APPLICATION",
      label: "Superintendent's s.479(3) written application",
      actorRole: "prison",
      state: sup ? "done" : reached || flagged ? "open" : "blocked",
      detail: sup
        ? "The jail superintendent recorded the s.479(3) application to the court."
        : "s.479(3): on completion of the period the superintendent must forthwith apply in writing to the court.",
      receipt: receiptOf(sup),
      openForDays: sup ? null : reached ? thresholdDays : null,
    },
    {
      milestone: "APPLICATION_FILED",
      label: "Bail application filed by lawyer",
      actorRole: "lawyer",
      state: lastApp ? "done" : reached || flagged ? "open" : "blocked",
      detail: lastApp
        ? `Application #${lastApp.chain_app_id} filed; PDF hash registered on-chain.`
        : "Lawyer generates the draft, reviews it, and files it with a wallet signature.",
      receipt: lastApp
        ? {
            txHash: lastApp.tx_hash,
            explorerUrl: explorer(lastApp.tx_hash),
            wallet: lastApp.lawyer_wallet,
            chainTimestamp: lastApp.chain_timestamp,
            recordedAt: lastApp.created_at,
            offChain: false,
            orderId: null,
            applicationId: lastApp.chain_app_id,
          }
        : null,
      openForDays: lastApp ? null : reached ? thresholdDays : null,
    },
    {
      milestone: "ORDER_ATTESTED",
      label: "Order attested by Demo court issuer",
      actorRole: "issuer",
      state: active || orders.length ? "done" : lastApp ? "open" : "blocked",
      detail: active
        ? `Order ${active.order_id.slice(0, 10)}… is ACTIVE.`
        : orders.length
          ? `Latest order is ${orders.at(-1)!.status}.`
          : lastApp
            ? "Awaiting the issuer's attestation of an order on the filed application."
            : "Requires a filed application.",
      receipt: (() => {
        const o = active ?? orders.at(-1);
        return o
          ? {
              txHash: o.tx_hash,
              explorerUrl: explorer(o.tx_hash),
              wallet: o.issuer_wallet,
              chainTimestamp: o.chain_timestamp,
              recordedAt: o.created_at,
              offChain: false,
              orderId: o.order_id,
              applicationId: null,
            }
          : null;
      })(),
      openForDays: !orders.length && lastApp ? daysSince(lastApp.chain_timestamp, now) : null,
    },
    {
      milestone: "ORDER_RECEIVED_BY_PRISON",
      label: "Order received by prison",
      actorRole: "prison",
      state: received ? "done" : active ? "open" : "blocked",
      detail: received
        ? "The prison acknowledged receipt of the active order."
        : active
          ? "Awaiting the prison's acknowledgement of receipt."
          : "Requires an ACTIVE order.",
      receipt: receiptOf(received),
      openForDays: !received && active ? daysSince(active.chain_timestamp, now) : null,
    },
    {
      milestone: "RELEASE_ACKNOWLEDGED",
      label: "Release acknowledged by prison",
      actorRole: "prison",
      state: released ? "done" : received ? "open" : "blocked",
      detail: released
        ? "The prison acknowledged release under the active order."
        : received
          ? "Awaiting the prison's release acknowledgement."
          : "Requires receipt of an ACTIVE order.",
      receipt: receiptOf(released),
      openForDays: !released && received ? daysSince(received.chain_timestamp, now) : null,
    },
  ];

  const nextActions: WorkflowState["nextActions"] = [];
  if (screening.status === "INSUFFICIENT_INFORMATION")
    nextActions.push({ role: "caseworker", key: "missing_info", text: "Complete missing information", days: null });
  if (screening.status === "SPECIALIST_REVIEW_REQUIRED")
    nextActions.push({ role: "specialist", key: "specialist", text: "Specialist review: other offences/cases pending (s.479(2))", days: null });
  if (!released) {
    if (steps[1]!.state === "open")
      nextActions.push({
        role: "prison",
        key: "superintendent",
        text: "Threshold reached, superintendent application not recorded",
        days: steps[1]!.openForDays,
      });
    if (steps[2]!.state === "open")
      nextActions.push({ role: "lawyer", key: "file", text: "Bail application not yet filed", days: steps[2]!.openForDays });
    if (steps[3]!.state === "open")
      nextActions.push({ role: "issuer", key: "order", text: "Filed application awaiting order", days: steps[3]!.openForDays });
    if (steps[4]!.state === "open")
      nextActions.push({ role: "prison", key: "receipt", text: "Active order not yet acknowledged as received", days: steps[4]!.openForDays });
    if (steps[5]!.state === "open")
      nextActions.push({ role: "prison", key: "release", text: "Order received, release not yet acknowledged", days: steps[5]!.openForDays });
  }
  return { steps, activeOrderId: active?.order_id ?? null, nextActions };
}

export function caseSummary(ctx: Ctx, row: CaseRow) {
  const screening = liveScreening(ctx, row);
  const offence = offenceOf(ctx, row);
  const wf = workflowState(ctx, row, screening);
  return {
    id: row.id,
    personName: row.person_name,
    caseRef: row.case_ref,
    court: row.court,
    offenceLabel: offence ? offenceLabel(offence) : row.offence_id,
    status: screening.status,
    headline: statusHeadline(screening),
    qualifyingDays: screening.qualifyingDays,
    thresholdDays: screening.thresholdDays,
    daysSinceThreshold: screening.daysSinceThreshold,
    daysRemaining: screening.daysRemaining,
    chainStatus: row.chain_status,
    nextActions: wf.nextActions,
    currentStep: [...wf.steps].reverse().find((s) => s.state === "done")?.milestone ?? null,
    releaseAcknowledged: wf.steps[5]!.state === "done",
    updatedAt: row.updated_at,
  };
}

export function caseDetail(ctx: Ctx, id: string, viewer: User) {
  const row = getCaseRow(ctx, id);
  const screening = liveScreening(ctx, row);
  const offence = offenceOf(ctx, row);
  const snapshots = ctx.db
    .prepare("SELECT id, commitment, rule_version, tx_hash, created_at, snapshot_json FROM screening_snapshots WHERE case_id = ? ORDER BY id")
    .all(id) as (Pick<SnapshotRow, "id" | "commitment" | "rule_version" | "tx_hash" | "created_at" | "snapshot_json">)[];
  const orders = ordersOf(ctx, id, viewer.role === "issuer");
  return {
    case: {
      id: row.id,
      personName: row.person_name,
      age: row.age,
      caseRef: row.case_ref,
      court: row.court,
      stage: row.stage,
      offenceId: row.offence_id,
      custodyPeriods: custodyOf(row),
      previousConviction: row.previous_conviction,
      otherPendingCases: row.other_pending,
      excludedDays: row.excluded_days,
      excludedNote: row.excluded_note,
      recordCommitment: row.record_commitment,
      registerTx: row.register_tx,
      registerExplorerUrl: row.register_tx && ctx.chain ? ctx.chain.explorerTx(row.register_tx) : null,
      chainStatus: row.chain_status,
      chainError: row.chain_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    offence,
    screening,
    headline: statusHeadline(screening),
    snapshots: snapshots.map((s) => {
      const snap = JSON.parse(s.snapshot_json) as { result: ScreeningResult };
      return {
        id: s.id,
        commitment: s.commitment,
        ruleVersion: s.rule_version,
        txHash: s.tx_hash,
        explorerUrl: s.tx_hash && ctx.chain ? ctx.chain.explorerTx(s.tx_hash) : null,
        createdAt: s.created_at,
        asOf: snap.result.asOf,
        status: snap.result.status,
      };
    }),
    workflow: workflowState(ctx, row, screening),
    applications: applicationsOf(ctx, id).map((a) => ({
      id: a.id,
      chainAppId: a.chain_app_id,
      pdfHash: a.pdf_hash,
      lawyerWallet: a.lawyer_wallet,
      txHash: a.tx_hash,
      explorerUrl: ctx.chain ? ctx.chain.explorerTx(a.tx_hash) : null,
      chainTimestamp: a.chain_timestamp,
      hasOrder: orders.some((o) => o.application_id === a.id && o.status !== "PREPARED"),
    })),
    orders: orders.map((o) => ({
      orderId: o.order_id,
      applicationId: o.application_id,
      status: o.status,
      structuredHash: o.structured_hash,
      pdfHash: o.pdf_hash,
      issuerWallet: o.issuer_wallet,
      txHash: o.tx_hash,
      explorerUrl: o.tx_hash && ctx.chain ? ctx.chain.explorerTx(o.tx_hash) : null,
      chainTimestamp: o.chain_timestamp,
      revokeReason: o.status === "REVOKED" ? o.revoke_reason : null,
      revokeTx: o.revoke_tx,
      revokedAt: o.revoked_at,
      supersedes: o.supersedes,
      supersededBy: o.superseded_by,
      supersedeReason: o.supersedes && o.status !== "PREPARED" ? o.supersede_reason : null,
      structured: JSON.parse(o.structured_json) as unknown,
    })),
  };
}

export function dashboard(ctx: Ctx) {
  const rows = ctx.db.prepare("SELECT * FROM cases ORDER BY created_at").all() as CaseRow[];
  const cases = rows.map((r) => caseSummary(ctx, r));
  type Group = { key: string; role: string; title: string; items: { caseId: string; caseRef: string; personName: string; text: string; days: number | null; headline: string }[] };
  const groups: Group[] = [
    { key: "superintendent", role: "prison", title: "Threshold reached — superintendent s.479(3) application not recorded", items: [] },
    { key: "file", role: "lawyer", title: "Lawyer: bail application not yet filed", items: [] },
    { key: "order", role: "issuer", title: "Issuer: filed application awaiting order", items: [] },
    { key: "receipt", role: "prison", title: "Prison: active order not yet acknowledged as received", items: [] },
    { key: "release", role: "prison", title: "Prison: release not yet acknowledged", items: [] },
    { key: "specialist", role: "specialist", title: "Specialist review required (s.479(2))", items: [] },
    { key: "missing_info", role: "caseworker", title: "Caseworker: information missing", items: [] },
  ];
  for (const c of cases) {
    for (const a of c.nextActions) {
      groups
        .find((g) => g.key === a.key)
        ?.items.push({ caseId: c.id, caseRef: c.caseRef, personName: c.personName, text: a.text, days: a.days, headline: c.headline });
    }
  }
  for (const g of groups) g.items.sort((a, b) => (b.days ?? -1) - (a.days ?? -1));
  const approaching = cases
    .filter((c) => c.status === "APPROACHING_THRESHOLD")
    .sort((a, b) => (a.daysRemaining ?? 0) - (b.daysRemaining ?? 0));
  return { groups, approaching, cases };
}
