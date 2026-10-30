import { describe, expect, it } from "vitest";
import {
  REASON_TEXT,
  screenCase,
  statusHeadline,
  validateCustodyPeriods,
  type ScreeningInput,
  type ScreeningResult,
} from "../src/screening/engine.js";
import { findOffence, type OffenceVariant } from "../src/screening/offences.js";
import { addDays } from "../src/screening/dates.js";

const AS_OF = "2026-10-30";

function offence(id: string): OffenceVariant {
  const o = findOffence(id);
  if (!o) throw new Error(`missing offence ${id}`);
  return o;
}

/** One ongoing custody period that has lasted exactly `days` days (inclusive) as of AS_OF. */
function ongoingFor(days: number) {
  return [{ start: addDays(AS_OF, -(days - 1)), end: null }];
}

function input(overrides: Partial<ScreeningInput> = {}): ScreeningInput {
  return {
    offence: offence("bns-303-2-first"), // max 1095 days
    custodyPeriods: ongoingFor(100),
    excludedDays: 0,
    previousConviction: "yes",
    otherPendingCases: "no",
    asOf: AS_OF,
    ...overrides,
  };
}

describe("one-half threshold (ceil)", () => {
  // 1095 / 2 = 547.5 -> 548
  it("is approaching one day before the ceil boundary", () => {
    const r = screenCase(input({ custodyPeriods: ongoingFor(547) }));
    expect(r.status).toBe("APPROACHING_THRESHOLD");
    expect(r.fraction).toBe("1/2");
    expect(r.thresholdDays).toBe(548);
    expect(r.countedDays).toBe(547);
    expect(r.daysRemaining).toBe(1);
    expect(r.estimatedThresholdDate).toBe("2026-10-31");
  });

  it("is reached exactly on the ceil boundary", () => {
    const r = screenCase(input({ custodyPeriods: ongoingFor(548) }));
    expect(r.status).toBe("THRESHOLD_REACHED_REVIEW_REQUIRED");
    expect(r.daysSinceThreshold).toBe(0);
    expect(r.estimatedThresholdDate).toBe(AS_OF);
    expect(statusHeadline(r)).toBe("Threshold reached today — s.479(3) application and legal review required");
  });

  it("reports how long ago the threshold was reached", () => {
    const r = screenCase(input({ custodyPeriods: ongoingFor(588) }));
    expect(r.status).toBe("THRESHOLD_REACHED_REVIEW_REQUIRED");
    expect(r.daysSinceThreshold).toBe(40);
    expect(r.estimatedThresholdDate).toBe(addDays(AS_OF, -40));
    expect(statusHeadline(r)).toBe("Threshold reached 40 days ago — s.479(3) application and legal review required");
    expect(r.reasonCodes).toContain("PREVIOUS_CONVICTION_ONE_HALF");
  });

  it("uses exact division when there is no remainder", () => {
    const r = screenCase(input({ offence: offence("bns-309-4"), custodyPeriods: ongoingFor(1825) }));
    expect(r.thresholdDays).toBe(1825);
    expect(r.status).toBe("THRESHOLD_REACHED_REVIEW_REQUIRED");
  });
});

describe("one-third threshold for a first-time offender (ceil)", () => {
  // 2555 / 3 = 851.67 -> 852
  const base = { offence: offence("bns-318-4"), previousConviction: "no" as const };

  it("is approaching at 851 days", () => {
    const r = screenCase(input({ ...base, custodyPeriods: ongoingFor(851) }));
    expect(r.fraction).toBe("1/3");
    expect(r.thresholdDays).toBe(852);
    expect(r.status).toBe("APPROACHING_THRESHOLD");
    expect(r.reasonCodes).toContain("FIRST_TIME_OFFENDER_ONE_THIRD");
  });

  it("is reached at 852 days", () => {
    const r = screenCase(input({ ...base, custodyPeriods: ongoingFor(852) }));
    expect(r.status).toBe("THRESHOLD_REACHED_REVIEW_REQUIRED");
  });
});

describe("unknown previous-conviction status", () => {
  it("computes at one-half and flags first-time status as unverified", () => {
    const r = screenCase(
      input({ offence: offence("bns-318-4"), previousConviction: "unknown", custodyPeriods: ongoingFor(900) }),
    );
    expect(r.fraction).toBe("1/2");
    expect(r.thresholdDays).toBe(1278); // 2555 / 2 = 1277.5 -> 1278
    expect(r.status).toBe("APPROACHING_THRESHOLD"); // 900 < 1278 although 900 >= 852 (one-third)
    expect(r.reasonCodes).toContain("FIRST_TIME_STATUS_UNVERIFIED");
    expect(r.oneThirdThresholdDays).toBe(852);
    expect(r.missingInfo.join(" ")).toMatch(/ever been convicted/);
  });
});

describe("custody interruptions and validation", () => {
  it("sums interrupted custody periods inclusively", () => {
    const r = screenCase(
      input({
        custodyPeriods: [
          { start: "2025-01-01", end: "2025-01-10" }, // 10 days
          { start: "2025-03-01", end: "2025-03-31" }, // 31 days
          { start: "2026-10-21", end: null }, // 10 days to 2026-10-30
        ],
      }),
    );
    expect(r.countedDays).toBe(51);
    expect(r.currentlyInCustody).toBe(true);
  });

  it("counts a same-day custody as one day", () => {
    const r = screenCase(input({ custodyPeriods: [{ start: "2026-01-05", end: "2026-01-05" }] }));
    expect(r.countedDays).toBe(1);
    expect(r.reasonCodes).toContain("NOT_CURRENTLY_IN_CUSTODY");
    expect(r.estimatedThresholdDate).toBeNull();
  });

  it.each([
    ["end before start", [{ start: "2026-02-10", end: "2026-02-01" }], /before start/],
    ["future start", [{ start: "2026-11-05", end: null }], /start date is in the future/],
    ["future end", [{ start: "2026-01-01", end: "2026-12-01" }], /end date is in the future/],
    ["impossible date", [{ start: "2026-02-30", end: null }], /not a valid date/],
    [
      "overlapping periods",
      [
        { start: "2025-01-01", end: "2025-02-01" },
        { start: "2025-01-15", end: "2025-03-01" },
      ],
      /overlap/,
    ],
    [
      "periods sharing a day",
      [
        { start: "2025-01-01", end: "2025-01-10" },
        { start: "2025-01-10", end: "2025-01-20" },
      ],
      /overlap/,
    ],
    [
      "two ongoing periods",
      [
        { start: "2025-01-01", end: null },
        { start: "2026-01-01", end: null },
      ],
      /Only one custody period/,
    ],
    [
      "ongoing period not the latest",
      [
        { start: "2025-01-01", end: null },
        { start: "2025-06-01", end: "2025-06-10" },
      ],
      /most recent/,
    ],
  ])("rejects %s", (_label, periods, message) => {
    expect(validateCustodyPeriods(periods, AS_OF).join(" ")).toMatch(message);
    const r = screenCase(input({ custodyPeriods: periods }));
    expect(r.status).toBe("INSUFFICIENT_INFORMATION");
    expect(r.reasonCodes).toContain("INVALID_CUSTODY_PERIODS");
    expect(r.countedDays).toBeNull();
  });

  it("requires at least one custody period", () => {
    const r = screenCase(input({ custodyPeriods: [] }));
    expect(r.status).toBe("INSUFFICIENT_INFORMATION");
    expect(r.reasonCodes).toContain("NO_CUSTODY_PERIODS");
  });
});

describe("excluded days (delay attributable to the accused)", () => {
  it("subtracts excluded days before comparing with the threshold", () => {
    const r = screenCase(input({ custodyPeriods: ongoingFor(560), excludedDays: 20 }));
    expect(r.countedDays).toBe(560);
    expect(r.qualifyingDays).toBe(540);
    expect(r.status).toBe("APPROACHING_THRESHOLD");
    expect(r.daysRemaining).toBe(8);
    expect(r.reasonCodes).toContain("EXCLUDED_DAYS_APPLIED");
  });

  it("rejects excluded days greater than counted custody", () => {
    const r = screenCase(input({ custodyPeriods: ongoingFor(30), excludedDays: 31 }));
    expect(r.status).toBe("INSUFFICIENT_INFORMATION");
    expect(r.reasonCodes).toContain("INVALID_EXCLUDED_DAYS");
    expect(r.errors[0]).toMatch(/cannot exceed/);
  });

  it.each([-1, 2.5, Number.NaN])("rejects invalid excluded days %s", (value) => {
    const r = screenCase(input({ excludedDays: value }));
    expect(r.reasonCodes).toContain("INVALID_EXCLUDED_DAYS");
  });

  it("allows excluded days equal to counted custody", () => {
    const r = screenCase(input({ custodyPeriods: ongoingFor(30), excludedDays: 30 }));
    expect(r.qualifyingDays).toBe(0);
    expect(r.status).toBe("APPROACHING_THRESHOLD");
  });
});

describe("s.479(2) other pending offences or cases", () => {
  it("routes to specialist review even when the threshold is reached", () => {
    const r = screenCase(input({ custodyPeriods: ongoingFor(700), otherPendingCases: "yes" }));
    expect(r.status).toBe("SPECIALIST_REVIEW_REQUIRED");
    expect(r.reasonCodes).toContain("OTHER_PENDING_CASES_S479_2");
    expect(r.reasonCodes).not.toContain("THRESHOLD_REACHED");
    // numbers stay visible for the specialist
    expect(r.thresholdDays).toBe(548);
  });

  it("treats unknown pending status as insufficient information", () => {
    const r = screenCase(input({ custodyPeriods: ongoingFor(700), otherPendingCases: "unknown" }));
    expect(r.status).toBe("INSUFFICIENT_INFORMATION");
    expect(r.reasonCodes).toContain("OTHER_PENDING_CASES_UNKNOWN");
    expect(r.missingInfo.join(" ")).toMatch(/s\.479\(2\)/);
  });
});

describe("offences outside the rule or unsupported", () => {
  it.each(["bns-103-1", "bns-64-1", "bns-310-2", "bns-309-6"])("%s (death/life) is outside the rule", (id) => {
    const r = screenCase(input({ offence: offence(id), custodyPeriods: ongoingFor(3000) }));
    expect(r.status).toBe("OUTSIDE_SCREENING_RULE");
    expect(r.reasonCodes).toEqual(["CAPITAL_OR_LIFE_OFFENCE"]);
    expect(r.thresholdDays).toBeNull();
  });

  it("fine-only offence is outside the rule", () => {
    const r = screenCase(input({ offence: offence("bns-292") }));
    expect(r.status).toBe("OUTSIDE_SCREENING_RULE");
    expect(r.reasonCodes).toEqual(["FINE_ONLY_OFFENCE"]);
  });

  it("unsupported offence variant is insufficient information", () => {
    const r = screenCase(input({ offence: offence("ndps-20") }));
    expect(r.status).toBe("INSUFFICIENT_INFORMATION");
    expect(r.reasonCodes).toEqual(["OFFENCE_UNSUPPORTED"]);
  });

  it("missing offence is insufficient information", () => {
    const r = screenCase(input({ offence: null }));
    expect(r.status).toBe("INSUFFICIENT_INFORMATION");
    expect(r.reasonCodes).toEqual(["OFFENCE_NOT_SELECTED"]);
  });
});

describe("output wording and metadata", () => {
  const FORBIDDEN = [/must be released/i, /automatic bail/i, /unlawfully detained/i];

  it("never uses conclusory release language", () => {
    const results: ScreeningResult[] = [
      screenCase(input({ custodyPeriods: ongoingFor(900) })),
      screenCase(input({ custodyPeriods: ongoingFor(10) })),
      screenCase(input({ otherPendingCases: "yes" })),
      screenCase(input({ offence: offence("bns-103-1") })),
      screenCase(input({ offence: null })),
    ];
    const text = [
      ...results.flatMap((r) => [statusHeadline(r), ...r.missingInfo, ...r.errors]),
      ...Object.values(REASON_TEXT),
    ].join("\n");
    for (const pattern of FORBIDDEN) expect(text).not.toMatch(pattern);
  });

  it("includes rule version and legal source", () => {
    const r = screenCase(input());
    expect(r.ruleVersion).toBe("BNSS-479-v1");
    expect(r.ruleVersionNumber).toBe(1);
    expect(r.legalSource).toMatch(/s\.479/);
    expect(r.asOf).toBe(AS_OF);
  });

  it("returns exactly one known status", () => {
    const allowed = [
      "APPROACHING_THRESHOLD",
      "THRESHOLD_REACHED_REVIEW_REQUIRED",
      "SPECIALIST_REVIEW_REQUIRED",
      "OUTSIDE_SCREENING_RULE",
      "INSUFFICIENT_INFORMATION",
    ];
    expect(allowed).toContain(screenCase(input()).status);
  });
});
