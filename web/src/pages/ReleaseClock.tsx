import { useEffect, useState } from "react";
import { deployment, networkLabel, publicProvider, readRegistry } from "../lib/deployment";
import { loadReleaseClock, type ReleaseClockData } from "../lib/releaseClock";
import { formatUnix } from "../lib/format";
import { Card, Hash, Notice, Spinner } from "../components/ui";

const MILESTONE_LABEL: Record<string, string> = {
  REGISTERED: "Registered",
  THRESHOLD_FLAGGED: "Threshold flagged",
  SUPERINTENDENT_APPLICATION: "Superintendent application",
  APPLICATION_FILED: "Application filed",
  ORDER_ATTESTED: "Order attested",
  ORDER_RECEIVED_BY_PRISON: "Order received by prison",
  RELEASE_ACKNOWLEDGED: "Release acknowledged",
};

export function ReleaseClock() {
  const [data, setData] = useState<ReleaseClockData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const registry = readRegistry();
    const provider = publicProvider();
    if (!registry || !provider || !deployment) return;
    loadReleaseClock(registry, provider, deployment.deploymentBlock).then(setData, () =>
      setError("Could not reach the blockchain RPC to read registry events."),
    );
  }, []);

  const tiles: [string, number][] = data
    ? [
        ["Cases tracked", data.totals.casesTracked],
        ["Thresholds flagged", data.totals.thresholdsFlagged],
        ["Superintendent applications recorded", data.totals.superintendentApplications],
        ["Bail applications filed", data.totals.applicationsFiled],
        ["Orders attested", data.totals.ordersAttested],
        ["Releases acknowledged", data.totals.releasesAcknowledged],
      ]
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-3xl font-semibold">Release clock</h1>
        <p className="mt-1 max-w-3xl text-stone-700">
          An anonymised view built directly from registry events{deployment ? ` on ${networkLabel()}` : ""}. It shows only random case IDs,
          milestones and timestamps — no names, FIR numbers, offences or custody details. All cases are synthetic.
        </p>
      </div>

      {!deployment ? (
        <Notice tone="warn" title="No registry is configured">
          Off-chain demo mode: there are no on-chain events to aggregate.
        </Notice>
      ) : error ? (
        <Notice tone="error" title="RPC unavailable">
          {error}
        </Notice>
      ) : !data ? (
        <Spinner label="Reading registry events…" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            {tiles.map(([label, value]) => (
              <div key={label} className="rounded-xl border border-paper-200 bg-white p-5 shadow-sm">
                <div className="font-serif text-4xl font-semibold text-navy-900">{value}</div>
                <div className="mt-1 text-[0.95rem] text-stone-700">{label}</div>
              </div>
            ))}
          </div>
          {data.totals.ordersRevoked > 0 && (
            <p className="text-sm text-stone-600">
              {data.totals.ordersRevoked} order{data.totals.ordersRevoked === 1 ? " was" : "s were"} revoked (history remains on the log).
            </p>
          )}

          <Card title="Cases on the registry">
            {data.rows.length === 0 ? (
              <p className="text-stone-600">No cases registered yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-left text-[0.95rem]">
                  <caption className="sr-only">Synthetic cases with current milestone and elapsed days</caption>
                  <thead>
                    <tr className="border-b border-paper-200 text-sm text-stone-600">
                      <th scope="col" className="py-2 pr-4 font-semibold">Case ID</th>
                      <th scope="col" className="py-2 pr-4 font-semibold">Current milestone</th>
                      <th scope="col" className="py-2 pr-4 font-semibold">Days since flagged on-chain</th>
                      <th scope="col" className="py-2 pr-4 font-semibold">Days since last activity</th>
                      <th scope="col" className="py-2 font-semibold">Registered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.caseId} className="border-b border-paper-100">
                        <td className="py-2 pr-4">
                          <Hash value={r.caseId} />
                        </td>
                        <td className="py-2 pr-4">{MILESTONE_LABEL[r.currentMilestone] ?? r.currentMilestone}</td>
                        <td className="py-2 pr-4">{r.daysSinceFlagged ?? "—"}</td>
                        <td className="py-2 pr-4">{r.daysSinceLastActivity}</td>
                        <td className="py-2">{formatUnix(r.registeredAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-4 text-xs text-stone-500">
              Elapsed days are measured from on-chain timestamps and show workflow delay, not statutory deadlines. Events read from block{" "}
              {data.fromBlock} to {data.toBlock}.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
