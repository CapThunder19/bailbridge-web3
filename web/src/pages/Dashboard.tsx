import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { CaseSummary } from "../lib/types";
import { Card, Notice, Spinner, StatusBadge } from "../components/ui";

export function Dashboard() {
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ cases: CaseSummary[] }>("/cases").then(
      (r) => setCases(r.cases),
      (e) => setError(e instanceof ApiError ? e.message : "Could not load cases."),
    );
  }, []);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!cases) return <Spinner />;

  return (
    <div className="space-y-6">
      <h1 className="font-serif text-3xl font-semibold">Cases</h1>
      {cases.length === 0 ? (
        <Notice>No cases yet. Create one from “New case”, or run the demo seed script.</Notice>
      ) : (
        <Card>
          <ul className="divide-y divide-paper-200">
            {cases.map((c) => (
              <li key={c.id} className="py-3">
                <Link to={`/cases/${c.id}`} className="block rounded-lg p-2 hover:bg-paper">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">
                      {c.personName} <span className="font-normal text-stone-600">· {c.caseRef}</span>
                    </span>
                    <StatusBadge status={c.status} />
                  </div>
                  <p className="mt-1 text-[0.95rem] text-navy-800">{c.headline}</p>
                  <p className="text-sm text-stone-600">{c.offenceLabel}</p>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
