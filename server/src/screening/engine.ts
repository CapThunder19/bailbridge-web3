/**
 * s.479 BNSS undertrial detention screening engine (pure, deterministic).
 *
 * This is a SCREENING aid for legal-aid workers. It flags cases that need legal
 * review; it never decides bail. Every output must be reviewed by a lawyer.
 *
 * Rules implemented (BNSS, Act 46 of 2023, s.479 — formerly s.436A CrPC):
 *  - s.479(1): threshold at one-half of the maximum imprisonment for the offence;
 *    one-third for a first-time offender (never convicted of any offence).
 *  - Not applicable where the offence is punishable with death or life imprisonment.
 *  - s.479(2): where investigation, inquiry or trial in more than one offence or in
 *    multiple cases is pending, release under this section is barred → specialist review.
 *  - Detention attributable to delay caused by the accused is excluded.
 *  - s.479(3): on reaching the threshold the jail superintendent must forthwith
 *    apply in writing to the court (tracked by the Release Tracker, not here).
 *
 * Prototype conventions (require legal validation):
 *  - maximum sentence: years x 365 days, months x 30 days (stored in offences.csv);
 *  - custody days are counted inclusively (the day custody starts and ends both count);
 *  - threshold days = ceil(maxSentenceDays x fraction).
 */
import type { OffenceVariant } from "./offences.js";
import { addDays, fromDayNumber, inclusiveDays, toDayNumber } from "./dates.js";

export const RULE_VERSION = "BNSS-479-v1";
/** Numeric rule version anchored on-chain with each screening snapshot. */
export const RULE_VERSION_NUMBER = 1;
export const LEGAL_SOURCE =
  "Bharatiya Nagarik Suraksha Sanhita, 2023 (Act 46 of 2023), s.479 (formerly s.436A CrPC); offence punishments per Bharatiya Nyaya Sanhita, 2023 (Act 45 of 2023) as recorded in data/offences.csv.";

export type ScreeningStatus =
  | "APPROACHING_THRESHOLD"
  | "THRESHOLD_REACHED_REVIEW_REQUIRED"
  | "SPECIALIST_REVIEW_REQUIRED"
  | "OUTSIDE_SCREENING_RULE"
  | "INSUFFICIENT_INFORMATION";

export type TriState = "yes" | "no" | "unknown";

export type ReasonCode =
  | "INVALID_CUSTODY_PERIODS"
  | "NO_CUSTODY_PERIODS"
  | "OFFENCE_NOT_SELECTED"
  | "OFFENCE_UNSUPPORTED"
  | "CAPITAL_OR_LIFE_OFFENCE"
  | "FINE_ONLY_OFFENCE"
  | "INVALID_EXCLUDED_DAYS"
  | "OTHER_PENDING_CASES_S479_2"
  | "OTHER_PENDING_CASES_UNKNOWN"
  | "FIRST_TIME_OFFENDER_ONE_THIRD"
  | "PREVIOUS_CONVICTION_ONE_HALF"
  | "FIRST_TIME_STATUS_UNVERIFIED"
  | "EXCLUDED_DAYS_APPLIED"
  | "THRESHOLD_REACHED"
  | "BELOW_THRESHOLD"
  | "NOT_CURRENTLY_IN_CUSTODY";

export interface CustodyPeriod {
  /** YYYY-MM-DD, first day in custody. */
  start: string;
  /** YYYY-MM-DD, last day in custody; null = still in custody. */
  end: string | null;
}

export interface ScreeningInput {
  offence: OffenceVariant | null;
  custodyPeriods: CustodyPeriod[];
  /** Days of detention attributable to delay caused by the accused. */
  excludedDays: number;
  previousConviction: TriState;
  otherPendingCases: TriState;
  /** Screening date (YYYY-MM-DD). */
  asOf: string;
}

export interface ScreeningResult {
  status: ScreeningStatus;
  ruleVersion: typeof RULE_VERSION;
  ruleVersionNumber: typeof RULE_VERSION_NUMBER;
  legalSource: string;
  asOf: string;
  offenceId: string | null;
  maxSentenceDays: number | null;
  countedDays: number | null;
  excludedDays: number;
  qualifyingDays: number | null;
  fraction: "1/2" | "1/3" | null;
  thresholdDays: number | null;
  /** Informational one-third threshold when first-time status is unverified. */
  oneThirdThresholdDays: number | null;
  daysRemaining: number | null;
  daysSinceThreshold: number | null;
  /** Estimated date the threshold was / will be reached, assuming continuous custody. */
  estimatedThresholdDate: string | null;
  currentlyInCustody: boolean;
  reasonCodes: ReasonCode[];
  missingInfo: string[];
  errors: string[];
}

/** Validate custody periods. Returns human-readable errors (empty array = valid). */
export function validateCustodyPeriods(periods: CustodyPeriod[], asOf: string): string[] {
  const errors: string[] = [];
  const asOfDay = toDayNumber(asOf);
  if (asOfDay === null) return [`Screening date "${asOf}" is not a valid YYYY-MM-DD date.`];

  const parsed: { start: number; end: number; ongoing: boolean; index: number }[] = [];
  periods.forEach((p, i) => {
    const label = `Custody period ${i + 1}`;
    const start = toDayNumber(p.start);
    const end = p.end === null ? asOfDay : toDayNumber(p.end);
    if (start === null) {
      errors.push(`${label}: start date "${p.start}" is not a valid date.`);
      return;
    }
    if (end === null) {
      errors.push(`${label}: end date "${p.end}" is not a valid date.`);
      return;
    }
    if (start > asOfDay) errors.push(`${label}: start date is in the future.`);
    if (p.end !== null && end > asOfDay) errors.push(`${label}: end date is in the future.`);
    if (end < start) errors.push(`${label}: end date is before start date.`);
    parsed.push({ start, end, ongoing: p.end === null, index: i });
  });
  if (errors.length) return errors;

  const ongoing = parsed.filter((p) => p.ongoing);
  if (ongoing.length > 1) errors.push("Only one custody period can be ongoing (no end date).");

  const sorted = [...parsed].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.start <= prev.end) {
      errors.push(`Custody periods ${prev.index + 1} and ${cur.index + 1} overlap.`);
    }
  }
  const last = sorted[sorted.length - 1];
  if (ongoing.length === 1 && last && !last.ongoing) {
    errors.push("The ongoing custody period must be the most recent one.");
  }
  return errors;
}

/** Sum of inclusive custody days (assumes periods already validated). */
export function countCustodyDays(periods: CustodyPeriod[], asOf: string): number {
  return periods.reduce((sum, p) => sum + inclusiveDays(p.start, p.end ?? asOf), 0);
}

function baseResult(input: ScreeningInput): ScreeningResult {
  return {
    status: "INSUFFICIENT_INFORMATION",
    ruleVersion: RULE_VERSION,
    ruleVersionNumber: RULE_VERSION_NUMBER,
    legalSource: LEGAL_SOURCE,
    asOf: input.asOf,
    offenceId: input.offence?.id ?? null,
    maxSentenceDays: input.offence?.maxSentenceDays ?? null,
    countedDays: null,
    excludedDays: input.excludedDays,
    qualifyingDays: null,
    fraction: null,
    thresholdDays: null,
    oneThirdThresholdDays: null,
    daysRemaining: null,
    daysSinceThreshold: null,
    estimatedThresholdDate: null,
    currentlyInCustody: input.custodyPeriods.some((p) => p.end === null),
    reasonCodes: [],
    missingInfo: [],
    errors: [],
  };
}

/** Screen a case against s.479 BNSS. Always returns exactly one status. */
export function screenCase(input: ScreeningInput): ScreeningResult {
  const r = baseResult(input);
  const reasons = r.reasonCodes;

  // 1. Custody periods: invalid input is never silently counted.
  const periodErrors = validateCustodyPeriods(input.custodyPeriods, input.asOf);
  if (periodErrors.length) {
    reasons.push("INVALID_CUSTODY_PERIODS");
    r.errors.push(...periodErrors);
    r.missingInfo.push("Valid, non-overlapping custody periods");
    return r;
  }
  if (input.custodyPeriods.length > 0) {
    r.countedDays = countCustodyDays(input.custodyPeriods, input.asOf);
  }

  // 2. Offence variant.
  const offence = input.offence;
  if (!offence) {
    reasons.push("OFFENCE_NOT_SELECTED");
    r.missingInfo.push("Offence variant (from the reviewed offence list)");
    return r;
  }
  if (offence.capitalOrLife) {
    r.status = "OUTSIDE_SCREENING_RULE";
    reasons.push("CAPITAL_OR_LIFE_OFFENCE");
    return r;
  }
  if (offence.fineOnly) {
    r.status = "OUTSIDE_SCREENING_RULE";
    reasons.push("FINE_ONLY_OFFENCE");
    return r;
  }
  if (!offence.supported || offence.maxSentenceDays === null) {
    reasons.push("OFFENCE_UNSUPPORTED");
    r.missingInfo.push("Verified maximum punishment for this offence variant (not modelled in the dataset)");
    return r;
  }

  // 3. Custody totals and excluded days.
  if (r.countedDays === null) {
    reasons.push("NO_CUSTODY_PERIODS");
    r.missingInfo.push("At least one custody period");
    return r;
  }
  const excluded = input.excludedDays;
  if (!Number.isInteger(excluded) || excluded < 0) {
    reasons.push("INVALID_EXCLUDED_DAYS");
    r.errors.push("Excluded days must be a whole number of days, zero or more.");
    return r;
  }
  if (excluded > r.countedDays) {
    reasons.push("INVALID_EXCLUDED_DAYS");
    r.errors.push(`Excluded days (${excluded}) cannot exceed counted custody days (${r.countedDays}).`);
    return r;
  }
  if (excluded > 0) reasons.push("EXCLUDED_DAYS_APPLIED");
  const qualifying = r.countedDays - excluded;
  r.qualifyingDays = qualifying;

  // 4. Fraction: one-third only for a verified first-time offender.
  const max = offence.maxSentenceDays;
  if (input.previousConviction === "no") {
    r.fraction = "1/3";
    r.thresholdDays = Math.ceil(max / 3);
    reasons.push("FIRST_TIME_OFFENDER_ONE_THIRD");
  } else {
    r.fraction = "1/2";
    r.thresholdDays = Math.ceil(max / 2);
    if (input.previousConviction === "yes") {
      reasons.push("PREVIOUS_CONVICTION_ONE_HALF");
    } else {
      reasons.push("FIRST_TIME_STATUS_UNVERIFIED");
      r.oneThirdThresholdDays = Math.ceil(max / 3);
      r.missingInfo.push(
        `Whether the accused has ever been convicted of any offence (if never convicted, the one-third threshold of ${r.oneThirdThresholdDays} days applies)`,
      );
    }
  }

  const threshold = r.thresholdDays;
  const reached = qualifying >= threshold;
  // Reference day for date estimates: today if in custody, else last day of custody.
  const lastEnd = input.custodyPeriods
    .map((p) => toDayNumber(p.end ?? input.asOf)!)
    .reduce((a, b) => Math.max(a, b));
  const refDate = r.currentlyInCustody ? input.asOf : fromDayNumber(lastEnd);
  if (!r.currentlyInCustody) reasons.push("NOT_CURRENTLY_IN_CUSTODY");

  if (reached) {
    r.daysSinceThreshold = qualifying - threshold;
    r.daysRemaining = 0;
    r.estimatedThresholdDate = addDays(refDate, -(qualifying - threshold));
  } else {
    r.daysRemaining = threshold - qualifying;
    r.estimatedThresholdDate = r.currentlyInCustody ? addDays(input.asOf, threshold - qualifying) : null;
  }

  // 5. s.479(2): other pending offences/cases bar release under this section.
  if (input.otherPendingCases === "yes") {
    r.status = "SPECIALIST_REVIEW_REQUIRED";
    reasons.push("OTHER_PENDING_CASES_S479_2");
    return r;
  }
  if (input.otherPendingCases === "unknown") {
    r.status = "INSUFFICIENT_INFORMATION";
    reasons.push("OTHER_PENDING_CASES_UNKNOWN");
    r.missingInfo.push("Whether investigation, inquiry or trial is pending in any other offence or case (s.479(2))");
    return r;
  }

  r.status = reached ? "THRESHOLD_REACHED_REVIEW_REQUIRED" : "APPROACHING_THRESHOLD";
  reasons.push(reached ? "THRESHOLD_REACHED" : "BELOW_THRESHOLD");
  return r;
}

/** Plain-language explanation of each reason code (UI and PDFs). */
export const REASON_TEXT: Record<ReasonCode, string> = {
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
  FIRST_TIME_OFFENDER_ONE_THIRD:
    "Recorded as never convicted of any offence: one-third threshold under the s.479(1) proviso.",
  PREVIOUS_CONVICTION_ONE_HALF: "Previous conviction recorded: one-half threshold under s.479(1).",
  FIRST_TIME_STATUS_UNVERIFIED:
    "First-time status unverified: computed at one-half. Verify conviction history before relying on the one-third threshold.",
  EXCLUDED_DAYS_APPLIED: "Days of delay attributable to the accused have been excluded.",
  THRESHOLD_REACHED: "Qualifying detention has reached the threshold.",
  BELOW_THRESHOLD: "Qualifying detention is below the threshold.",
  NOT_CURRENTLY_IN_CUSTODY: "The accused is not recorded as currently in custody; dates are not projected.",
};

/** Human-readable status line. Deliberately avoids conclusory language about release. */
export function statusHeadline(r: ScreeningResult): string {
  switch (r.status) {
    case "THRESHOLD_REACHED_REVIEW_REQUIRED": {
      const n = r.daysSinceThreshold ?? 0;
      const when = n === 0 ? "today" : `${n} day${n === 1 ? "" : "s"} ago`;
      return `Threshold reached ${when} — s.479(3) application and legal review required`;
    }
    case "APPROACHING_THRESHOLD":
      return `Approaching threshold — ${r.daysRemaining} qualifying day${r.daysRemaining === 1 ? "" : "s"} remaining`;
    case "SPECIALIST_REVIEW_REQUIRED":
      return "Specialist review required — other offences or cases pending (s.479(2))";
    case "OUTSIDE_SCREENING_RULE":
      return "Outside the s.479 screening rule";
    case "INSUFFICIENT_INFORMATION":
      return "Insufficient information to screen";
  }
}
