import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { CaseDetail, CustodyPeriod, Offence, ScreeningResult, TriState } from "../lib/types";
import { todayIso } from "../lib/format";
import { ReviewClock } from "../components/ReviewClock";
import { Button, Card, Field, Notice, Spinner, inputClass } from "../components/ui";

interface FormState {
  personName: string;
  age: string;
  caseRef: string;
  court: string;
  stage: string;
  offenceId: string;
  custodyPeriods: { start: string; end: string; ongoing: boolean }[];
  previousConviction: TriState;
  otherPendingCases: TriState;
  excludedDays: string;
  excludedNote: string;
}

const INITIAL: FormState = {
  personName: "",
  age: "",
  caseRef: "",
  court: "",
  stage: "Trial pending",
  offenceId: "",
  custodyPeriods: [{ start: "", end: "", ongoing: true }],
  previousConviction: "unknown",
  otherPendingCases: "unknown",
  excludedDays: "0",
  excludedNote: "",
};

function TriSelect({ value, onChange, labels }: { value: TriState; onChange: (v: TriState) => void; labels: Record<TriState, string> }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup">
      {(["no", "yes", "unknown"] as TriState[]).map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`rounded-lg px-3 py-2 text-[0.95rem] ring-1 ring-inset ${
            value === v ? "bg-navy-800 font-semibold text-white ring-navy-800" : "bg-white text-navy-800 ring-stone-300 hover:bg-navy-50"
          }`}
        >
          {labels[v]}
        </button>
      ))}
    </div>
  );
}

export function NewCase() {
  const navigate = useNavigate();
  const [offences, setOffences] = useState<Offence[] | null>(null);
  const [form, setForm] = useState<FormState>(INITIAL);
  const [preview, setPreview] = useState<{ screening: ScreeningResult; headline: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ offences: Offence[] }>("/offences").then((r) => setOffences(r.offences), () => setError("Could not load offence list."));
  }, []);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const screeningFields = useMemo(() => {
    const custodyPeriods: CustodyPeriod[] = form.custodyPeriods.map((p) => ({ start: p.start, end: p.ongoing ? null : p.end }));
    return {
      offenceId: form.offenceId,
      custodyPeriods,
      previousConviction: form.previousConviction,
      otherPendingCases: form.otherPendingCases,
      excludedDays: Number(form.excludedDays || 0),
      excludedNote: form.excludedNote,
      stage: form.stage || "Not recorded",
    };
  }, [form]);

  // Live, unsaved screening preview.
  useEffect(() => {
    const ready = screeningFields.offenceId && screeningFields.custodyPeriods.every((p) => p.start && (p.end === null || p.end));
    if (!ready || !Number.isInteger(screeningFields.excludedDays)) {
      setPreview(null);
      return;
    }
    const t = setTimeout(() => {
      api.post<{ screening: ScreeningResult; headline: string }>("/screening/preview", screeningFields).then(
        (r) => {
          setPreview(r);
          setPreviewError(null);
        },
        (e) => setPreviewError(e instanceof ApiError ? e.message : "Preview unavailable."),
      );
    }, 350);
    return () => clearTimeout(t);
  }, [screeningFields]);

  const selected = offences?.find((o) => o.id === form.offenceId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const detail = await api.post<CaseDetail>("/cases", {
        ...screeningFields,
        personName: form.personName,
        age: form.age === "" ? null : Number(form.age),
        caseRef: form.caseRef,
        court: form.court,
      });
      navigate(`/cases/${detail.case.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the case.");
      setBusy(false);
    }
  }

  if (!offences && !error) return <Spinner />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-3xl font-semibold">New case</h1>
        <p className="mt-1 text-stone-700">
          Use synthetic data only. Personal details stay off-chain; only a salted commitment is anchored on-chain when you save.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <form onSubmit={submit} className="space-y-6">
          <Card title="Person and case">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name (synthetic)">
                <input className={inputClass} value={form.personName} onChange={(e) => set("personName", e.target.value)} required />
              </Field>
              <Field label="Age">
                <input className={inputClass} type="number" min={0} max={120} value={form.age} onChange={(e) => set("age", e.target.value)} />
              </Field>
              <Field label="Case reference">
                <input className={inputClass} value={form.caseRef} onChange={(e) => set("caseRef", e.target.value)} placeholder="SYN/2026/0001" required />
              </Field>
              <Field label="Court">
                <input className={inputClass} value={form.court} onChange={(e) => set("court", e.target.value)} placeholder="Demo Sessions Court" required />
              </Field>
              <Field label="Stage of proceedings">
                <input className={inputClass} value={form.stage} onChange={(e) => set("stage", e.target.value)} required />
              </Field>
            </div>
          </Card>

          <Card title="Offence">
            <Field label="Offence variant" hint="From the reviewed offence list (BNS, with former IPC equivalents).">
              <select className={inputClass} value={form.offenceId} onChange={(e) => set("offenceId", e.target.value)} required>
                <option value="">Select…</option>
                {offences?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                    {o.capitalOrLife ? " (death/life)" : o.fineOnly ? " (fine only)" : !o.supported ? " (not modelled)" : ""}
                  </option>
                ))}
              </select>
            </Field>
            {selected && (
              <div className="mt-3 rounded-lg bg-paper p-3 text-[0.95rem]">
                <p>
                  <strong>Punishment:</strong> {selected.punishmentText}
                </p>
                {selected.mappedAct && (
                  <p className="text-stone-700">
                    Former {selected.mappedAct} s.{selected.mappedSection}
                  </p>
                )}
                {selected.notes && <p className="mt-1 text-sm text-stone-600">{selected.notes}</p>}
              </div>
            )}
          </Card>

          <Card title="Custody">
            <div className="space-y-4">
              {form.custodyPeriods.map((p, i) => (
                <fieldset key={i} className="rounded-lg border border-paper-200 p-4">
                  <legend className="px-1 text-sm font-semibold text-stone-700">Custody period {i + 1}</legend>
                  <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <Field label="From">
                      <input
                        className={inputClass}
                        type="date"
                        max={todayIso()}
                        value={p.start}
                        onChange={(e) => set("custodyPeriods", form.custodyPeriods.map((q, j) => (j === i ? { ...q, start: e.target.value } : q)))}
                        required
                      />
                    </Field>
                    <Field label="To">
                      <input
                        className={inputClass}
                        type="date"
                        max={todayIso()}
                        value={p.ongoing ? "" : p.end}
                        disabled={p.ongoing}
                        onChange={(e) => set("custodyPeriods", form.custodyPeriods.map((q, j) => (j === i ? { ...q, end: e.target.value } : q)))}
                        required={!p.ongoing}
                      />
                    </Field>
                    <label className="flex items-center gap-2 pb-3 text-[0.95rem]">
                      <input
                        type="checkbox"
                        className="h-5 w-5"
                        checked={p.ongoing}
                        onChange={(e) =>
                          set(
                            "custodyPeriods",
                            form.custodyPeriods.map((q, j) => (j === i ? { ...q, ongoing: e.target.checked } : { ...q, ongoing: e.target.checked ? false : q.ongoing })),
                          )
                        }
                      />
                      Still in custody
                    </label>
                  </div>
                  {form.custodyPeriods.length > 1 && (
                    <button
                      type="button"
                      className="mt-2 text-sm text-red-800 underline"
                      onClick={() => set("custodyPeriods", form.custodyPeriods.filter((_, j) => j !== i))}
                    >
                      Remove period
                    </button>
                  )}
                </fieldset>
              ))}
              <Button
                type="button"
                variant="secondary"
                onClick={() => set("custodyPeriods", [...form.custodyPeriods.map((q) => ({ ...q, ongoing: false })), { start: "", end: "", ongoing: true }])}
              >
                + Add custody period (interruption)
              </Button>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-[10rem_1fr]">
              <Field label="Excluded days" hint="Delay caused by the accused.">
                <input className={inputClass} type="number" min={0} value={form.excludedDays} onChange={(e) => set("excludedDays", e.target.value)} />
              </Field>
              <Field label="Note on excluded days">
                <input className={inputClass} value={form.excludedNote} onChange={(e) => set("excludedNote", e.target.value)} placeholder="e.g. adjournments sought by the defence" />
              </Field>
            </div>
          </Card>

          <Card title="History">
            <div className="space-y-5">
              <Field label="Ever convicted of any offence?" hint="First-time offender means never convicted — not merely a first arrest.">
                <TriSelect value={form.previousConviction} onChange={(v) => set("previousConviction", v)} labels={{ no: "Never convicted", yes: "Previously convicted", unknown: "Unknown" }} />
              </Field>
              <Field label="Investigation, inquiry or trial pending in any other offence or case?" hint="s.479(2) — if yes, the case is routed to specialist review.">
                <TriSelect value={form.otherPendingCases} onChange={(v) => set("otherPendingCases", v)} labels={{ no: "No", yes: "Yes", unknown: "Unknown" }} />
              </Field>
            </div>
          </Card>

          {error && <Notice tone="error">{error}</Notice>}
          <Button type="submit" disabled={busy} className="w-full sm:w-auto">
            {busy ? "Saving…" : "Save case and anchor commitment"}
          </Button>
        </form>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <Card title="Review Clock (preview)">
            {preview ? (
              <ReviewClock screening={preview.screening} headline={preview.headline} />
            ) : (
              <p className="text-stone-600">{previewError ?? "Select an offence and enter custody dates to see the screening."}</p>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
