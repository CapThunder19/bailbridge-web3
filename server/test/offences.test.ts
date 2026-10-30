import { describe, expect, it } from "vitest";
import { findOffence, loadOffences, offenceLabel, parseCsv, parseOffences, OFFENCE_COLUMNS } from "../src/screening/offences.js";

const HEADER = OFFENCE_COLUMNS.join(",");

describe("offences.csv dataset", () => {
  const list = loadOffences();

  it("has at least 10 reviewed variants with unique ids", () => {
    expect(list.length).toBeGreaterThanOrEqual(10);
    expect(new Set(list.map((o) => o.id)).size).toBe(list.length);
  });

  it("records key variants correctly", () => {
    expect(findOffence("bns-303-2-first")).toMatchObject({ maxSentenceDays: 1095, mappedSection: "379" });
    expect(findOffence("bns-318-4")).toMatchObject({ maxSentenceDays: 2555, mappedSection: "420" });
    expect(findOffence("bns-329-3")).toMatchObject({ maxSentenceDays: 90 }); // 3 months x 30
    expect(findOffence("bns-103-1")).toMatchObject({ capitalOrLife: true, maxSentenceDays: null, supported: true });
    expect(findOffence("bns-292")).toMatchObject({ fineOnly: true, maxSentenceDays: null, supported: true });
    expect(findOffence("ndps-20")).toMatchObject({ supported: false, maxSentenceDays: null });
  });

  it("every row cites a source", () => {
    for (const o of list) expect(o.sourceUrl).toMatch(/^https:\/\//);
  });

  it("formats a readable label", () => {
    expect(offenceLabel(findOffence("bns-318-4")!)).toBe(
      "BNS s.318(4) — Cheating and dishonestly inducing delivery of property",
    );
  });
});

describe("CSV parsing and validation", () => {
  it("handles quoted commas and escaped quotes", () => {
    expect(parseCsv('a,"b, c","d ""e"""\r\n1,2,3\n')).toEqual([
      ["a", "b, c", 'd "e"'],
      ["1", "2", "3"],
    ]);
  });

  const row = (overrides: Partial<Record<(typeof OFFENCE_COLUMNS)[number], string>>) => {
    const base: Record<string, string> = {
      id: "x",
      act: "BNS",
      section: "1",
      subsection: "",
      offence: "Test",
      punishmentText: "Test",
      maxSentenceDays: "365",
      capitalOrLife: "false",
      fineOnly: "false",
      mappedAct: "",
      mappedSection: "",
      sourceUrl: "https://example.org",
      notes: "",
      ...overrides,
    };
    return OFFENCE_COLUMNS.map((c) => base[c]).join(",");
  };

  it("rejects a wrong header", () => {
    expect(() => parseOffences("id,act\nx,BNS")).toThrow(/header/);
  });

  it("rejects duplicate ids", () => {
    expect(() => parseOffences([HEADER, row({}), row({})].join("\n"))).toThrow(/duplicate/);
  });

  it("rejects a max sentence on a capital/life offence", () => {
    expect(() => parseOffences([HEADER, row({ capitalOrLife: "true" })].join("\n"))).toThrow(/must be empty/);
  });

  it("rejects a non-integer max sentence", () => {
    expect(() => parseOffences([HEADER, row({ maxSentenceDays: "36.5" })].join("\n"))).toThrow(/positive integer/);
  });

  it("marks a variant with no max sentence as unsupported", () => {
    const [o] = parseOffences([HEADER, row({ maxSentenceDays: "" })].join("\n"));
    expect(o?.supported).toBe(false);
  });
});
