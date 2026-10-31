import type { Contract } from "ethers";
import { DOCUMENT_KIND, MILESTONE_NAMES, ORDER_STATUS } from "./deployment";

const ZERO32 = "0x" + "00".repeat(32);

export interface MilestoneView {
  milestone: (typeof MILESTONE_NAMES)[number];
  actor: string;
  timestamp: number;
  orderId: string | null;
  appId: number;
  evidenceCommitment: string;
}

export interface OrderView {
  orderId: string;
  caseId: string;
  appId: number;
  structuredOrderHash: string;
  pdfHash: string;
  issuer: string;
  attestedAt: number;
  status: (typeof ORDER_STATUS)[number];
  statusChangedAt: number;
  revocationReasonCommitment: string | null;
  supersedes: string | null;
  supersededBy: string | null;
}

export interface ApplicationView {
  appId: number;
  caseId: string;
  pdfHash: string;
  lawyer: string;
  filedAt: number;
  orderId: string | null;
}

export type VerifyResult =
  | { kind: "no-registry" }
  | { kind: "invalid-input"; message: string }
  | { kind: "rpc-unavailable"; message: string }
  | { kind: "not-registered"; hash: string | null; orderId: string | null }
  | {
      kind: "order";
      /** null = no file supplied (QR lookup only). */
      fileMatches: boolean | null;
      fileHash: string | null;
      order: OrderView;
      issuerAuthorised: boolean;
      milestones: MilestoneView[];
    }
  | { kind: "application"; fileHash: string; application: ApplicationView; lawyerAuthorised: boolean; milestones: MilestoneView[] }
  | { kind: "structured-hash"; fileHash: string; orderId: string };

const nz = (v: string) => (v === ZERO32 ? null : v);

function toOrder(orderId: string, o: Record<string, unknown> & Record<number, unknown>): OrderView {
  return {
    orderId,
    caseId: o.caseId as string,
    appId: Number(o.appId),
    structuredOrderHash: o.structuredOrderHash as string,
    pdfHash: o.pdfHash as string,
    issuer: o.issuer as string,
    attestedAt: Number(o.attestedAt),
    status: ORDER_STATUS[Number(o.status)] ?? "NONE",
    statusChangedAt: Number(o.statusChangedAt),
    revocationReasonCommitment: nz(o.revocationReasonCommitment as string),
    supersedes: nz(o.supersedes as string),
    supersededBy: nz(o.supersededBy as string),
  };
}

export async function readMilestones(registry: Contract, caseId: string): Promise<MilestoneView[]> {
  const list = (await registry.getFunction("getMilestones")(caseId)) as Record<string, unknown>[];
  return list.map((m) => ({
    milestone: MILESTONE_NAMES[Number(m.milestone)] ?? "NONE",
    actor: m.actor as string,
    timestamp: Number(m.timestamp),
    orderId: nz(m.orderId as string),
    appId: Number(m.appId),
    evidenceCommitment: m.evidenceCommitment as string,
  }));
}

function isRpcError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e?.code === "NETWORK_ERROR" ||
    e?.code === "SERVER_ERROR" ||
    e?.code === "TIMEOUT" ||
    /failed to fetch|fetch failed|ECONNREFUSED|could not detect network|network/i.test(e?.message ?? "")
  );
}

async function orderResult(registry: Contract, orderId: string, fileHash: string | null, fileMatches: boolean | null): Promise<VerifyResult> {
  const raw = await registry.getFunction("getOrder")(orderId);
  const order = toOrder(orderId, raw);
  if (order.status === "NONE") return { kind: "not-registered", hash: fileHash, orderId };
  const [issuerAuthorised, milestones] = await Promise.all([
    registry.getFunction("hasRole")(await registry.getFunction("ISSUER_ROLE")(), order.issuer) as Promise<boolean>,
    readMilestones(registry, order.caseId),
  ]);
  return { kind: "order", fileMatches, fileHash, order, issuerAuthorised, milestones };
}

/**
 * Verify against the registry. `fileHash` is computed locally from the dropped file
 * (the file is never uploaded). `orderId` comes from the QR link.
 * PDF hashes are only ever compared with registered PDF hashes — never with JSON hashes.
 */
export async function verify(registry: Contract | null, opts: { fileHash?: string | null; orderId?: string | null }): Promise<VerifyResult> {
  if (!registry) return { kind: "no-registry" };
  const fileHash = opts.fileHash ?? null;
  const orderId = opts.orderId ?? null;
  if (orderId && !/^0x[0-9a-fA-F]{64}$/.test(orderId)) return { kind: "invalid-input", message: "The order ID in the link is malformed." };
  try {
    if (!fileHash) {
      if (!orderId) return { kind: "invalid-input", message: "Drop a PDF or open a verification link." };
      return await orderResult(registry, orderId, null, null);
    }

    const [kindRaw, id] = (await registry.getFunction("verifyDocument")(fileHash)) as [bigint, string];
    const kind = DOCUMENT_KIND[Number(kindRaw)] ?? "NONE";

    if (orderId) {
      // Expected order known from the QR: the file must be that order's registered PDF bytes.
      const matches = kind === "ORDER_PDF" && id.toLowerCase() === orderId.toLowerCase();
      return await orderResult(registry, orderId, fileHash, matches);
    }
    if (kind === "NONE") return { kind: "not-registered", hash: fileHash, orderId: null };
    if (kind === "ORDER_PDF") return await orderResult(registry, id, fileHash, true);
    if (kind === "ORDER_STRUCTURED") return { kind: "structured-hash", fileHash, orderId: id };

    const appId = BigInt(id);
    const a = await registry.getFunction("getApplication")(appId);
    const application: ApplicationView = {
      appId: Number(appId),
      caseId: a.caseId as string,
      pdfHash: a.pdfHash as string,
      lawyer: a.lawyer as string,
      filedAt: Number(a.filedAt),
      orderId: nz(a.orderId as string),
    };
    const [lawyerAuthorised, milestones] = await Promise.all([
      registry.getFunction("hasRole")(await registry.getFunction("LAWYER_ROLE")(), application.lawyer) as Promise<boolean>,
      readMilestones(registry, application.caseId),
    ]);
    return { kind: "application", fileHash, application, lawyerAuthorised, milestones };
  } catch (err) {
    if (isRpcError(err)) return { kind: "rpc-unavailable", message: "Could not reach the blockchain RPC. The record may exist — try again later." };
    throw err;
  }
}
