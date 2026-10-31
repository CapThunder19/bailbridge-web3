import { REASON_TEXT, statusHeadline, type ScreeningResult } from "./screening/engine.js";
import type { OffenceVariant } from "./screening/offences.js";
import { offenceLabel } from "./screening/offences.js";

export interface SummaryFacts {
  offence: OffenceVariant | null;
  screening: ScreeningResult;
  previousConviction: string;
  otherPendingCases: string;
  stage: string;
  excludedNote: string;
}

export interface AdvisorySummary {
  source: "gemini" | "fallback";
  model: string | null;
  text: string;
  note: string;
}

const FORBIDDEN = [
  /must be released/i,
  /automatic(ally)? bail/i,
  /unlawful(ly)? detained/i,
  /entitled to (be released|release|bail)/i,
  /\bshould be (granted|released)\b/i,
  /\bwill be released\b/i,
  /\bI recommend\b/i,
];

export function containsForbiddenLanguage(text: string): boolean {
  return FORBIDDEN.some((p) => p.test(text));
}

const NOTE = "Advisory only. Explains recorded facts and missing information; it does not recommend any decision.";

/** Deterministic summary used when no AI key is set or the AI output is rejected. */
export function fallbackSummary(f: SummaryFacts): AdvisorySummary {
  const s = f.screening;
  const lines: string[] = [];
  lines.push(`Screening status: ${statusHeadline(s)}.`);
  if (f.offence) lines.push(`Recorded offence: ${offenceLabel(f.offence)}. Punishment as recorded: ${f.offence.punishmentText}`);
  if (s.countedDays !== null) {
    lines.push(
      `Counted custody is ${s.countedDays} days; ${s.excludedDays} days are excluded as delay attributable to the accused${f.excludedNote ? ` (${f.excludedNote})` : ""}, leaving ${s.qualifyingDays ?? "—"} qualifying days.`,
    );
  }
  if (s.thresholdDays !== null && s.fraction) {
    lines.push(`The ${s.fraction} threshold is ${s.thresholdDays} days of a ${s.maxSentenceDays}-day maximum term.`);
  }
  for (const code of s.reasonCodes) lines.push(REASON_TEXT[code]);
  if (s.missingInfo.length) lines.push(`Information still needed: ${s.missingInfo.join("; ")}.`);
  lines.push("A lawyer must review these facts against the case record before any step is taken.");
  return { source: "fallback", model: null, text: lines.join("\n"), note: NOTE };
}

/** Facts sent to the model: no names, case references, FIR numbers or court names. */
function promptFor(f: SummaryFacts): string {
  const s = f.screening;
  const facts = {
    offence: f.offence ? offenceLabel(f.offence) : null,
    punishment: f.offence?.punishmentText ?? null,
    screeningStatus: s.status,
    statusHeadline: statusHeadline(s),
    countedCustodyDays: s.countedDays,
    excludedDays: s.excludedDays,
    excludedDaysNote: f.excludedNote || null,
    qualifyingDays: s.qualifyingDays,
    maxSentenceDays: s.maxSentenceDays,
    fraction: s.fraction,
    thresholdDays: s.thresholdDays,
    daysSinceThreshold: s.daysSinceThreshold,
    daysRemaining: s.daysRemaining,
    previousConviction: f.previousConviction,
    otherPendingOffencesOrCases: f.otherPendingCases,
    stage: f.stage,
    reasons: s.reasonCodes.map((c) => REASON_TEXT[c]),
    missingInformation: s.missingInfo,
  };
  return [
    "You are assisting a legal-aid caseworker in India. Write a short advisory note (max 120 words, plain English, 3-6 short sentences or bullets).",
    "Rules: Explain only the facts below and list missing information. Do NOT recommend any decision, do NOT predict outcomes,",
    "do NOT say anyone must, should or will be released, granted bail, or is unlawfully detained. Do not invent facts or law.",
    "Context: s.479 BNSS screening (one-half of maximum term; one-third for a person never convicted; not for death/life offences;",
    "s.479(2) bars release under the section where other offences/cases are pending; s.479(3) requires the jail superintendent to apply in writing).",
    "End with: 'A lawyer must review this against the case record.'",
    `Facts (JSON): ${JSON.stringify(facts)}`,
  ].join("\n");
}

export async function advisorySummary(
  f: SummaryFacts,
  gemini: { apiKey: string | null; model: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AdvisorySummary> {
  if (!gemini.apiKey) return fallbackSummary(f);
  try {
    const res = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(gemini.model)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": gemini.apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: promptFor(f) }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 400 },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim();
    if (!text) throw new Error("empty response");
    if (containsForbiddenLanguage(text)) {
      return { ...fallbackSummary(f), note: `${NOTE} (AI output was rejected by the wording filter; showing the deterministic summary.)` };
    }
    return { source: "gemini", model: gemini.model, text, note: NOTE };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    return { ...fallbackSummary(f), note: `${NOTE} (AI unavailable: ${reason}; showing the deterministic summary.)` };
  }
}
