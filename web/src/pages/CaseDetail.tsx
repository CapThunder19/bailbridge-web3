import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useSession } from "../lib/session";
import type { AdvisorySummary, CaseDetail as Detail } from "../lib/types";
import { TRI_LABEL, formatDate, plural } from "../lib/format";
import { ReviewClock } from "../components/ReviewClock";
import { Timeline } from "../components/Timeline";
import { Card, Dl, Hash, Notice, Spinner } from "../components/ui";
import { LawyerPanel } from "../components/panels/LawyerPanel";

function AdvisoryCard({ caseId, version }: { caseId: string; version: string }) {
  const [summary, setSummary] = useState<AdvisorySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSummary(null);
    api.get<{ summary: AdvisorySummary }>(`/cases/${caseId}/summary`).then(
      (r) => setSummary(r.summary),
      (e) => setError(e instanceof ApiError ? e.message : "Summary unavailable."),
    );
  }, [caseId, version]);
  return (
    <Card
      title="Advisory summary"
      actions={
        summary && (
          <span className="rounded bg-paper-100 px-2 py-0.5 text-xs text-stone-700">
            {summary.source === "gemini" ? `AI (${summary.model})` : "Deterministic summary"}
          </span>
        )
      }
    >
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : !summary ? (
        <Spinner label="Preparing summary…" />
      ) : (
        <>
          <div className="whitespace-pre-line text-[0.95rem] leading-relaxed text-navy-900">{summary.text}</div>
          <p className="mt-3 text-xs text-stone-500">{summary.note}</p>
        </>
      )}
    </Card>
  );
}

const CHAIN_STATUS_TEXT = {
  offchain: "Off-chain only (no registry configured)",
  pending: "Anchoring on-chain…",
  anchored: "Anchored on-chain",
  failed: "Anchoring failed — will retry automatically",
} as const;

export function CaseDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useSession();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    api.get<Detail>(`/cases/${id}`).then(
      (d) => {
        setDetail(d);
        setError(null);
      },
      (e) => setError(e instanceof ApiError ? e.message : "Could not load the case."),
    );
  }, [id]);

  useEffect(load, [load]);

  // Poll while background anchoring is in progress.
  useEffect(() => {
    if (detail?.case.chainStatus !== "pending") return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [detail?.case.chainStatus, load]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!detail || !user) return <Spinner />;
  const c = detail.case;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/dashboard" className="text-sm text-navy-700 underline">
          ← Dashboard
        </Link>
        <h1 className="mt-2 font-serif text-3xl font-semibold">{c.personName}</h1>
        <p className="text-stone-700">
          {c.caseRef} · {c.court} · {detail.offence ? `${detail.offence.act} s.${detail.offence.section}${detail.offence.subsection} — ${detail.offence.offence}` : c.offenceId}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="space-y-6">
          <Card title="Review Clock">
            <ReviewClock screening={detail.screening} headline={detail.headline} />
          </Card>
          <AdvisoryCard caseId={c.id} version={c.updatedAt} />
          <Card title="Release Tracker">
            <p className="mb-4 text-sm text-stone-600">
              Each milestone is an attestation by a specific role. “Open N days” badges show workflow delay, not statutory deadlines.
            </p>
            <Timeline steps={detail.workflow.steps} />
          </Card>
          {user.role === "lawyer" && <LawyerPanel detail={detail} user={user} onChange={load} />}
        </div>

        <aside className="space-y-6">
          <Card title="Case facts">
            <Dl
              rows={[
                ["Age", c.age ?? "—"],
                ["Stage", c.stage],
                [
                  "Custody",
                  <ul key="c" className="space-y-0.5">
                    {c.custodyPeriods.map((p, i) => (
                      <li key={i}>
                        {formatDate(p.start)} → {p.end ? formatDate(p.end) : "present"}
                      </li>
                    ))}
                  </ul>,
                ],
                ["Excluded days", `${plural(c.excludedDays, "day")}${c.excludedNote ? ` — ${c.excludedNote}` : ""}`],
                ["Ever convicted", TRI_LABEL[c.previousConviction]],
                ["Other pending cases", TRI_LABEL[c.otherPendingCases]],
              ]}
            />
          </Card>

          <Card title="On-chain record">
            <p className={`mb-3 text-sm font-semibold ${c.chainStatus === "failed" ? "text-red-800" : "text-navy-800"}`}>
              {CHAIN_STATUS_TEXT[c.chainStatus]}
            </p>
            {c.chainError && <p className="mb-3 text-sm text-red-800">{c.chainError}</p>}
            <Dl
              rows={[
                ["Case ID", <Hash key="id" value={c.id} />],
                ["Record commitment", <Hash key="rc" value={c.recordCommitment} />],
                ["Registration tx", c.registerTx ? <Hash key="rt" value={c.registerTx} href={c.registerExplorerUrl} /> : "—"],
              ]}
            />
            <h3 className="mt-4 text-sm font-semibold uppercase tracking-wide text-stone-600">Screening snapshots</h3>
            <ul className="mt-2 space-y-2 text-sm">
              {detail.snapshots.map((s) => (
                <li key={s.id} className="rounded bg-paper px-2 py-1.5">
                  <div>
                    {formatDate(s.asOf)} · rule v{s.ruleVersion}
                  </div>
                  <div>
                    Commitment <Hash value={s.commitment} />
                  </div>
                  <div>Tx {s.txHash ? <Hash value={s.txHash} href={s.explorerUrl} /> : <span className="text-stone-500">not anchored</span>}</div>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs text-stone-500">
              Commitments are salted hashes of the off-chain record. They prove the record has not changed since it was anchored — not that it
              is true. No names, offences or dates are stored on-chain.
            </p>
          </Card>
        </aside>
      </div>
    </div>
  );
}
