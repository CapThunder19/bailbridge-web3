import type { TxStatus } from "../lib/wallet";
import { explorerTx } from "../lib/deployment";
import { Hash } from "./ui";

const STEPS: { phase: TxStatus["phase"]; label: string }[] = [
  { phase: "awaiting_wallet", label: "Awaiting wallet" },
  { phase: "submitted", label: "Submitted" },
  { phase: "recording", label: "Verified by server" },
  { phase: "confirmed", label: "Confirmed" },
];

const ORDER: Record<TxStatus["phase"], number> = {
  idle: -1,
  checking: -1,
  awaiting_wallet: 0,
  submitted: 1,
  recording: 2,
  confirmed: 3,
  failed: -1,
};

/** awaiting wallet → submitted → confirmed / failed, with explorer link and plain errors. */
export function TxStatusView({ status, lastPhase }: { status: TxStatus; lastPhase?: TxStatus["phase"] }) {
  if (status.phase === "idle") return null;
  const failed = status.phase === "failed";
  const reached = failed ? ORDER[lastPhase ?? "idle"] : ORDER[status.phase];
  const explorer = status.txHash ? explorerTx(status.txHash) : null;

  return (
    <div className={`mt-4 rounded-lg border p-4 ${failed ? "border-red-200 bg-red-50" : "border-navy-100 bg-paper"}`} aria-live="polite">
      <ol className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        {STEPS.map((s, i) => {
          const done = i <= reached && !(failed && i === reached + 1);
          const current = !failed && i === reached + 1 && status.phase !== "confirmed";
          return (
            <li key={s.phase} className="flex items-center gap-2">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                  done ? "bg-navy-800 text-white" : current ? "bg-gold-300 text-navy-900" : "bg-stone-200 text-stone-600"
                }`}
                aria-hidden
              >
                {done ? "✓" : i + 1}
              </span>
              <span className={done ? "font-semibold text-navy-900" : "text-stone-600"}>{s.label}</span>
              {i < STEPS.length - 1 && <span className="text-stone-300" aria-hidden>→</span>}
            </li>
          );
        })}
      </ol>
      {status.phase === "checking" && <p className="mt-3 text-sm text-stone-700">{status.message}</p>}
      {status.message && status.phase !== "checking" && (
        <p className={`mt-3 text-[0.95rem] ${failed ? "font-semibold text-red-900" : "text-navy-900"}`}>
          {failed ? "Failed: " : ""}
          {status.message}
        </p>
      )}
      {status.txHash && (
        <p className="mt-2 text-sm text-stone-700">
          Transaction: <Hash value={status.txHash} href={explorer} />
          {!explorer && <span className="ml-1 text-stone-500">(local chain — no public explorer)</span>}
        </p>
      )}
    </div>
  );
}
