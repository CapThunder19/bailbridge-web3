/**
 * Canonical JSON: object keys sorted recursively, no whitespace, no undefined.
 * The same logical value always serialises to the same bytes, so its hash is stable.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value, "$"));
}

function normalise(value: unknown, at: string): Json {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number at ${at}`);
      return value;
    case "object": {
      if (Array.isArray(value)) return value.map((v, i) => normalise(v, `${at}[${i}]`));
      const out: { [key: string]: Json } = {};
      for (const key of Object.keys(value as object).sort()) {
        const v = (value as Record<string, unknown>)[key];
        if (v === undefined) continue;
        out[key] = normalise(v, `${at}.${key}`);
      }
      return out;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value} at ${at}`);
  }
}
