import type { ScreeningResult } from "../lib/types";
import { REASON_TEXT, formatDate, plural } from "../lib/format";
import { Dl, StatusBadge } from "./ui";

/** Progress bar "X / Y qualifying days", status badge, headline, reasons and the calculation. */
export function ReviewClock({ screening, headline, compact = false }: { screening: ScreeningResult; headline: string; compact?: boolean }) {
  const s = screening;
  const hasNumbers = s.qualifyingDays !== null && s.thresholdDays !== null;
  const pct = hasNumbers ? Math.min(100, Math.round((s.qualifyingDays! / s.thresholdDays!) * 100)) : 0;
  const reached = s.status === "THRESHOLD_REACHED_REVIEW_REQUIRED";

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={s.status} />
        <span className="text-sm text-stone-600">as of {formatDate(s.asOf)}</span>
      </div>
      <p className={`mt-3 font-serif text-2xl font-semibold leading-snug ${reached ? "text-gold-700" : "text-navy-900"}`}>{headline}</p>

      {hasNumbers && (
        <div className="mt-5">
          <div className="flex items-baseline justify-between text-[0.95rem]">
            <span className="font-semibold">
              {s.qualifyingDays} / {s.thresholdDays} qualifying days
            </span>
            <span className="text-stone-600">
              {s.fraction} of {s.maxSentenceDays} days
            </span>
          </div>
          <div
            className="mt-2 h-4 overflow-hidden rounded-full bg-paper-200"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={s.thresholdDays!}
            aria-valuenow={Math.min(s.qualifyingDays!, s.thresholdDays!)}
            aria-label="Qualifying days toward the s.479 threshold"
          >
            <div className={`h-full rounded-full ${reached ? "bg-gold-500" : "bg-navy-600"}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {!compact && (
        <>
          {hasNumbers && (
            <div className="mt-5 rounded-lg bg-paper p-4">
              <Dl
                rows={[
                  ["Counted custody", plural(s.countedDays ?? 0, "day")],
                  ["Excluded (accused-caused delay)", `− ${plural(s.excludedDays, "day")}`],
                  ["Qualifying detention", <strong key="q">{plural(s.qualifyingDays!, "day")}</strong>],
                  ["Maximum term", `${s.maxSentenceDays} days`],
                  ["Fraction", s.fraction === "1/3" ? "One-third (never convicted)" : "One-half"],
                  ["Threshold (rounded up)", plural(s.thresholdDays!, "day")],
                  [
                    reached ? "Estimated date reached" : "Estimated threshold date",
                    s.estimatedThresholdDate ? formatDate(s.estimatedThresholdDate) : "Not projected (not in custody)",
                  ],
                  ...(s.oneThirdThresholdDays !== null
                    ? ([["If verified never convicted", `one-third = ${plural(s.oneThirdThresholdDays, "day")}`]] as [string, string][])
                    : []),
                ]}
              />
            </div>
          )}
          {s.reasonCodes.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-stone-600">Reasons</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-[0.95rem]">
                {s.reasonCodes.map((c) => (
                  <li key={c}>{REASON_TEXT[c] ?? c}</li>
                ))}
              </ul>
            </div>
          )}
          {s.missingInfo.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-red-800">Missing information</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-[0.95rem]">
                {s.missingInfo.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          )}
          {s.errors.length > 0 && (
            <ul className="mt-4 list-disc space-y-1 pl-5 text-[0.95rem] text-red-800">
              {s.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-xs text-stone-500">
            Screening aid only — it does not decide bail. Rule {s.ruleVersion}. Day counts use prototype conventions (years × 365, months × 30,
            inclusive custody days) that require legal validation.
          </p>
        </>
      )}
    </div>
  );
}
