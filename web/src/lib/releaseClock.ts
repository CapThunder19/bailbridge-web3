import type { Contract, Provider } from "ethers";
import { readMilestones } from "./verify";

export interface ReleaseClockRow {
  caseId: string;
  registeredAt: number;
  currentMilestone: string;
  milestoneCount: number;
  thresholdFlaggedAt: number | null;
  lastActivityAt: number;
  /** Days since the threshold was flagged on-chain (null if never flagged). */
  daysSinceFlagged: number | null;
  /** Days since the most recent on-chain activity for the case. */
  daysSinceLastActivity: number;
}

export interface ReleaseClockData {
  totals: {
    casesTracked: number;
    thresholdsFlagged: number;
    superintendentApplications: number;
    applicationsFiled: number;
    ordersAttested: number;
    ordersRevoked: number;
    releasesAcknowledged: number;
  };
  rows: ReleaseClockRow[];
  fromBlock: number;
  toBlock: number;
}

const DAY = 86_400;

/** Query an event in block chunks (public RPCs cap getLogs ranges). */
async function queryChunked(registry: Contract, eventName: string, fromBlock: number, toBlock: number, chunk: number) {
  const filter = registry.filters[eventName]!();
  const out = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = Math.min(toBlock, start + chunk - 1);
    out.push(...(await registry.queryFilter(filter, start, end)));
  }
  return out;
}

/**
 * Anonymised aggregate built from contract events since the deployment block, plus
 * per-case milestone reads. Contains no names, FIRs, offences or custody data —
 * only random case IDs, milestone names and timestamps.
 */
export async function loadReleaseClock(
  registry: Contract,
  provider: Provider,
  fromBlock: number,
  opts: { chunk?: number; now?: number } = {},
): Promise<ReleaseClockData> {
  const chunk = opts.chunk ?? 9_000;
  const toBlock = await provider.getBlockNumber();
  const [registered, milestones, attested, revoked] = await Promise.all([
    queryChunked(registry, "CaseRegistered", fromBlock, toBlock, chunk),
    queryChunked(registry, "MilestoneAttested", fromBlock, toBlock, chunk),
    queryChunked(registry, "OrderAttested", fromBlock, toBlock, chunk),
    queryChunked(registry, "OrderRevoked", fromBlock, toBlock, chunk),
  ]);

  const count = (n: number) =>
    milestones.filter((e) => "args" in e && Number((e.args as unknown as { milestone: bigint }).milestone) === n).length;

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const caseIds = registered.map((e) => ("args" in e ? (e.args as unknown as { caseId: string }).caseId : null)).filter((x): x is string => !!x);

  const rows: ReleaseClockRow[] = await Promise.all(
    caseIds.map(async (caseId) => {
      const [c, ms] = await Promise.all([registry.getFunction("getCase")(caseId), readMilestones(registry, caseId)]);
      const registeredAt = Number(c.registeredAt);
      const latest = ms.at(-1);
      const flagged = ms.find((m) => m.milestone === "THRESHOLD_FLAGGED");
      const released = ms.find((m) => m.milestone === "RELEASE_ACKNOWLEDGED");
      const lastActivityAt = Math.max(registeredAt, Number(c.screeningAnchoredAt), latest?.timestamp ?? 0);
      return {
        caseId,
        registeredAt,
        currentMilestone: released ? "RELEASE_ACKNOWLEDGED" : (latest?.milestone ?? "REGISTERED"),
        milestoneCount: ms.length,
        thresholdFlaggedAt: flagged?.timestamp ?? null,
        lastActivityAt,
        daysSinceFlagged: flagged ? Math.floor((now - flagged.timestamp) / DAY) : null,
        daysSinceLastActivity: Math.floor((now - lastActivityAt) / DAY),
      };
    }),
  );
  rows.sort((a, b) => b.registeredAt - a.registeredAt);

  return {
    totals: {
      casesTracked: registered.length,
      thresholdsFlagged: count(1),
      superintendentApplications: count(2),
      applicationsFiled: count(3),
      ordersAttested: attested.length,
      ordersRevoked: revoked.length,
      releasesAcknowledged: count(6),
    },
    rows,
    fromBlock,
    toBlock,
  };
}
