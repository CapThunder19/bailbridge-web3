import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** One reviewed offence variant from data/offences.csv. */
export interface OffenceVariant {
  id: string;
  act: string;
  section: string;
  subsection: string;
  offence: string;
  punishmentText: string;
  /** Maximum imprisonment in days (years x 365, months x 30). Null if not applicable or unsupported. */
  maxSentenceDays: number | null;
  capitalOrLife: boolean;
  fineOnly: boolean;
  mappedAct: string;
  mappedSection: string;
  sourceUrl: string;
  notes: string;
  /** False when the dataset cannot give a reliable maximum term for this variant. */
  supported: boolean;
}

export const OFFENCE_COLUMNS = [
  "id",
  "act",
  "section",
  "subsection",
  "offence",
  "punishmentText",
  "maxSentenceDays",
  "capitalOrLife",
  "fineOnly",
  "mappedAct",
  "mappedSection",
  "sourceUrl",
  "notes",
] as const;

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new Error("CSV: unterminated quoted field");
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

function parseBool(value: string, id: string, column: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`offences.csv ${id}: ${column} must be true or false`);
}

/** Parse and validate offence CSV text. Throws on any inconsistency. */
export function parseOffences(text: string): OffenceVariant[] {
  const [header, ...rows] = parseCsv(text);
  if (!header || header.join(",") !== OFFENCE_COLUMNS.join(",")) {
    throw new Error(`offences.csv: header must be ${OFFENCE_COLUMNS.join(",")}`);
  }
  const seen = new Set<string>();
  return rows.map((cells, index) => {
    if (cells.length !== OFFENCE_COLUMNS.length) {
      throw new Error(`offences.csv row ${index + 2}: expected ${OFFENCE_COLUMNS.length} columns, got ${cells.length}`);
    }
    const r = Object.fromEntries(OFFENCE_COLUMNS.map((c, i) => [c, (cells[i] ?? "").trim()])) as Record<
      (typeof OFFENCE_COLUMNS)[number],
      string
    >;
    if (!r.id) throw new Error(`offences.csv row ${index + 2}: id is required`);
    if (seen.has(r.id)) throw new Error(`offences.csv: duplicate id ${r.id}`);
    seen.add(r.id);

    const capitalOrLife = parseBool(r.capitalOrLife, r.id, "capitalOrLife");
    const fineOnly = parseBool(r.fineOnly, r.id, "fineOnly");
    let maxSentenceDays: number | null = null;
    if (r.maxSentenceDays !== "") {
      const n = Number(r.maxSentenceDays);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`offences.csv ${r.id}: maxSentenceDays must be a positive integer`);
      maxSentenceDays = n;
    }
    if (capitalOrLife && fineOnly) throw new Error(`offences.csv ${r.id}: cannot be both capitalOrLife and fineOnly`);
    if ((capitalOrLife || fineOnly) && maxSentenceDays !== null) {
      throw new Error(`offences.csv ${r.id}: maxSentenceDays must be empty for capital/life or fine-only offences`);
    }

    return {
      id: r.id,
      act: r.act,
      section: r.section,
      subsection: r.subsection,
      offence: r.offence,
      punishmentText: r.punishmentText,
      maxSentenceDays,
      capitalOrLife,
      fineOnly,
      mappedAct: r.mappedAct,
      mappedSection: r.mappedSection,
      sourceUrl: r.sourceUrl,
      notes: r.notes,
      supported: capitalOrLife || fineOnly || maxSentenceDays !== null,
    };
  });
}

const DEFAULT_CSV = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "offences.csv");

let cache: OffenceVariant[] | null = null;

/** Load the reviewed offence dataset (cached). */
export function loadOffences(file: string = DEFAULT_CSV): OffenceVariant[] {
  if (file === DEFAULT_CSV && cache) return cache;
  const list = parseOffences(readFileSync(file, "utf8"));
  if (file === DEFAULT_CSV) cache = list;
  return list;
}

export function findOffence(id: string, list: OffenceVariant[] = loadOffences()): OffenceVariant | null {
  return list.find((o) => o.id === id) ?? null;
}

/** Human label, e.g. "BNS s.318(4) — Cheating and dishonestly inducing delivery of property". */
export function offenceLabel(o: OffenceVariant): string {
  return `${o.act} s.${o.section}${o.subsection} — ${o.offence}`;
}
