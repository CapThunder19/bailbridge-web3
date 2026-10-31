import type { ScreeningStatus, TriState } from "./types";

export const STATUS_LABEL: Record<ScreeningStatus, string> = {
  APPROACHING_THRESHOLD: "Approaching threshold",
  THRESHOLD_REACHED_REVIEW_REQUIRED: "Threshold reached — review required",
  SPECIALIST_REVIEW_REQUIRED: "Specialist review required",
  OUTSIDE_SCREENING_RULE: "Outside screening rule",
  INSUFFICIENT_INFORMATION: "Insufficient information",
};

export const STATUS_STYLE: Record<ScreeningStatus, string> = {
  APPROACHING_THRESHOLD: "bg-navy-50 text-navy-800 ring-navy-200",
  THRESHOLD_REACHED_REVIEW_REQUIRED: "bg-gold-100 text-gold-700 ring-gold-300",
  SPECIALIST_REVIEW_REQUIRED: "bg-purple-50 text-purple-900 ring-purple-200",
  OUTSIDE_SCREENING_RULE: "bg-stone-100 text-stone-800 ring-stone-300",
  INSUFFICIENT_INFORMATION: "bg-red-50 text-red-900 ring-red-200",
};

export const REASON_TEXT: Record<string, string> = {
  INVALID_CUSTODY_PERIODS: "Custody periods are invalid (overlapping, future or reversed dates).",
  NO_CUSTODY_PERIODS: "No custody periods have been entered.",
  OFFENCE_NOT_SELECTED: "No offence variant has been selected.",
  OFFENCE_UNSUPPORTED: "The dataset does not model a reliable maximum punishment for this offence variant.",
  CAPITAL_OR_LIFE_OFFENCE: "The offence is punishable with death or life imprisonment; s.479 BNSS does not apply.",
  FINE_ONLY_OFFENCE: "The offence is punishable with fine only; there is no imprisonment term to measure against.",
  INVALID_EXCLUDED_DAYS: "Excluded days are invalid or exceed counted custody.",
  OTHER_PENDING_CASES_S479_2:
    "Investigation, inquiry or trial is pending in another offence or case; s.479(2) bars release under this section. Specialist review needed.",
  OTHER_PENDING_CASES_UNKNOWN: "It is not known whether other offences or cases are pending (s.479(2)).",
  FIRST_TIME_OFFENDER_ONE_THIRD: "Recorded as never convicted of any offence: one-third threshold under the s.479(1) proviso.",
  PREVIOUS_CONVICTION_ONE_HALF: "Previous conviction recorded: one-half threshold under s.479(1).",
  FIRST_TIME_STATUS_UNVERIFIED:
    "First-time status unverified: computed at one-half. Verify conviction history before relying on the one-third threshold.",
  EXCLUDED_DAYS_APPLIED: "Days of delay attributable to the accused have been excluded.",
  THRESHOLD_REACHED: "Qualifying detention has reached the threshold.",
  BELOW_THRESHOLD: "Qualifying detention is below the threshold.",
  NOT_CURRENTLY_IN_CUSTODY: "The accused is not recorded as currently in custody; dates are not projected.",
};

export const TRI_LABEL: Record<TriState, string> = { yes: "Yes", no: "No", unknown: "Unknown" };

export const ROLE_LABEL: Record<string, string> = {
  caseworker: "Caseworker",
  lawyer: "Lawyer",
  issuer: "Demo court issuer",
  prison: "Prison (superintendent)",
  registrar: "BailBridge registrar",
  specialist: "Specialist lawyer",
};

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function formatUnix(seconds: number | null | undefined): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
