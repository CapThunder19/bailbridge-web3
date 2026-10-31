import type { TimelineStep } from "../lib/types";
import { ROLE_LABEL, formatUnix, plural } from "../lib/format";
import { Hash } from "./ui";

const LETTERS = ["a", "b", "c", "d", "e", "f"];

/** Release Tracker: each milestone is an attestation by a specific role. */
export function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="relative space-y-5">
      {steps.map((s, i) => {
        const done = s.state === "done";
        const open = s.state === "open";
        return (
          <li key={s.milestone} className="relative flex gap-4">
            <div className="flex flex-col items-center">
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ring-2 ${
                  done
                    ? "bg-navy-800 text-white ring-navy-800"
                    : open
                      ? "bg-gold-100 text-gold-700 ring-gold-500"
                      : "bg-white text-stone-400 ring-stone-200"
                }`}
                aria-hidden
              >
                {done ? "✓" : LETTERS[i]}
              </span>
              {i < steps.length - 1 && <span className={`mt-1 w-0.5 flex-1 ${done ? "bg-navy-200" : "bg-stone-200"}`} aria-hidden />}
            </div>
            <div className="min-w-0 flex-1 pb-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 className={`font-semibold ${done || open ? "text-navy-900" : "text-stone-500"}`}>{s.label}</h3>
                <span className="rounded bg-paper-100 px-2 py-0.5 text-xs font-medium text-stone-700">{ROLE_LABEL[s.actorRole]}</span>
                <span className="sr-only">Status: {s.state}</span>
                {open && s.openForDays !== null && (
                  <span
                    className="rounded-full bg-gold-100 px-2.5 py-0.5 text-xs font-semibold text-gold-700 ring-1 ring-gold-300"
                    title="Workflow delay since this step became actionable. Not a statutory deadline."
                  >
                    open {plural(s.openForDays, "day")}
                  </span>
                )}
              </div>
              <p className={`mt-1 text-[0.95rem] ${done || open ? "text-navy-800" : "text-stone-500"}`}>{s.detail}</p>
              {s.receipt && (
                <div className="mt-2 space-y-1 rounded-lg bg-paper px-3 py-2 text-sm">
                  {s.receipt.offChain ? (
                    <p className="text-stone-600">Recorded off-chain only (no blockchain attestation in this mode).</p>
                  ) : (
                    <>
                      <p>
                        <span className="text-stone-600">Tx </span>
                        <Hash value={s.receipt.txHash} href={s.receipt.explorerUrl} />
                      </p>
                      <p>
                        <span className="text-stone-600">Wallet </span>
                        <Hash value={s.receipt.wallet} />
                        <span className="ml-2 text-stone-600">{formatUnix(s.receipt.chainTimestamp)}</span>
                      </p>
                      {s.receipt.orderId && (
                        <p>
                          <span className="text-stone-600">Order </span>
                          <Hash value={s.receipt.orderId} />
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
