/** Calendar-date helpers on ISO YYYY-MM-DD strings, computed in UTC (no time-of-day). */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Parse YYYY-MM-DD to a UTC day number. Returns null for malformed or impossible dates. */
export function toDayNumber(date: string): number | null {
  const m = ISO_DATE.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return Math.round(ms / MS_PER_DAY);
}

export function fromDayNumber(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const n = toDayNumber(date);
  if (n === null) throw new Error(`invalid date ${date}`);
  return fromDayNumber(n + days);
}

/** Inclusive count of calendar days from start to end (same day = 1). */
export function inclusiveDays(start: string, end: string): number {
  const a = toDayNumber(start);
  const b = toDayNumber(end);
  if (a === null || b === null) throw new Error("invalid date");
  return b - a + 1;
}

/** Today's date in UTC as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
