import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useSession } from "../lib/session";
import type { CaseSummary } from "../lib/types";
import { ROLE_LABEL, plural } from "../lib/format";
import { Card, Notice, Spinner, StatusBadge } from "../components/ui";

interface DashboardData {
  groups: {
    key: string;
    role: string;
    title: string;
    items: { caseId: string; caseRef: string; personName: string; text: string; days: number | null; headline: string }[];
  }[];
  approaching: CaseSummary[];
  cases: CaseSummary[];
}

function DelayBadge({ days }: { days: number | null }) {
  if (days === null) return null;
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-0.5 text-sm font-semibold ring-1 ring-inset ${
        days >= 30 ? "bg-red-50 text-red-900 ring-red-200" : days >= 7 ? "bg-gold-100 text-gold-700 ring-gold-300" : "bg-navy-50 text-navy-800 ring-navy-200"
      }`}
      title="Workflow delay — not a statutory deadline"
    >
      {plural(days, "day")}
    </span>
  );
}

const STEP_LABEL: Record<string, string> = {
  THRESHOLD_FLAGGED: "Flagged",
  SUPERINTENDENT_APPLICATION: "Superintendent application",
  APPLICATION_FILED: "Application filed",
  ORDER_ATTESTED: "Order attested",
  ORDER_RECEIVED_BY_PRISON: "Order received",
  RELEASE_ACKNOWLEDGED: "Release acknowledged",
};

export function Dashboard() {
  const { user } = useSession();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<DashboardData>("/dashboard").then(setData, (e) => setError(e instanceof ApiError ? e.message : "Could not load the dashboard."));
  }, []);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data || !user) return <Spinner />;

  const groups = data.groups.filter((g) => g.items.length > 0);
  // Show the signed-in role's queue first.
  groups.sort((a, b) => Number(b.role === user.role) - Number(a.role === user.role));

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-3xl font-semibold">Action queue</h1>
          <p className="mt-1 text-stone-700">Grouped by who must act next. Day badges show workflow delay, not statutory deadlines.</p>
        </div>
        {(user.role === "caseworker" || user.role === "lawyer") && (
          <Link to="/cases/new" className="rounded-lg bg-navy-800 px-4 py-2.5 font-semibold text-white hover:bg-navy-700">
            + New case
          </Link>
        )}
      </div>

      {data.cases.length === 0 && <Notice>No cases yet. Create one, or run the demo seed script.</Notice>}

      {groups.length === 0 && data.cases.length > 0 && <Notice tone="success">No open actions.</Notice>}

      <div className="grid gap-6 lg:grid-cols-2">
        {groups.map((g) => {
          const mine = g.role === user.role;
          const hero = g.key === "superintendent";
          return (
            <Card
              key={g.key}
              className={hero ? "border-gold-300 ring-1 ring-gold-300 lg:col-span-2" : ""}
              title={
                <span>
                  {g.title}{" "}
                  <span className="ml-1 rounded-full bg-navy-800 px-2 py-0.5 align-middle text-sm font-semibold text-white">{g.items.length}</span>
                </span>
              }
              actions={
                <span className={`rounded px-2 py-0.5 text-xs font-semibold ${mine ? "bg-gold-100 text-gold-700" : "bg-paper-100 text-stone-700"}`}>
                  {mine ? "Your queue" : ROLE_LABEL[g.role] ?? g.role}
                </span>
              }
            >
              <ul className="divide-y divide-paper-200">
                {g.items.map((it) => (
                  <li key={it.caseId + g.key}>
                    <Link to={`/cases/${it.caseId}`} className="flex items-start justify-between gap-3 rounded-lg px-2 py-3 hover:bg-paper">
                      <span className="min-w-0">
                        <span className="block font-semibold">
                          {it.personName} <span className="font-normal text-stone-600">· {it.caseRef}</span>
                        </span>
                        <span className="block text-[0.95rem] text-navy-800">
                          {hero && it.days !== null
                            ? `Threshold reached, superintendent application not recorded (${plural(it.days, "day")})`
                            : it.headline}
                        </span>
                      </span>
                      <DelayBadge days={it.days} />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
      </div>

      {data.approaching.length > 0 && (
        <Card title="Watch list: approaching threshold">
          <ul className="divide-y divide-paper-200">
            {data.approaching.map((c) => (
              <li key={c.id}>
                <Link to={`/cases/${c.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-3 hover:bg-paper">
                  <span>
                    <span className="font-semibold">{c.personName}</span> <span className="text-stone-600">· {c.caseRef}</span>
                  </span>
                  <span className="text-[0.95rem]">
                    {c.qualifyingDays} / {c.thresholdDays} days · <strong>{plural(c.daysRemaining ?? 0, "day")} remaining</strong>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {data.cases.length > 0 && (
        <Card title="All cases">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-left text-[0.95rem]">
              <thead>
                <tr className="border-b border-paper-200 text-sm text-stone-600">
                  <th scope="col" className="py-2 pr-3 font-semibold">Person · case</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Screening</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Latest milestone</th>
                  <th scope="col" className="py-2 font-semibold">Chain</th>
                </tr>
              </thead>
              <tbody>
                {data.cases.map((c) => (
                  <tr key={c.id} className="border-b border-paper-100 align-top">
                    <td className="py-2 pr-3">
                      <Link to={`/cases/${c.id}`} className="font-semibold text-navy-800 underline decoration-navy-200 hover:decoration-navy-800">
                        {c.personName}
                      </Link>
                      <div className="text-sm text-stone-600">
                        {c.caseRef} · {c.offenceLabel}
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="py-2 pr-3">{c.currentStep ? STEP_LABEL[c.currentStep] : "—"}</td>
                    <td className="py-2 text-sm">{c.chainStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
