import { useCallback, useRef, useState } from "react";
import { ApiError } from "./api";
import { explainWalletError, type TxPhase, type TxStatus } from "./wallet";

/**
 * Shared state machine for chain actions:
 * checking → awaiting wallet → submitted → recording (server verifies) → confirmed | failed.
 */
export function useTxFlow() {
  const [status, setStatus] = useState<TxStatus>({ phase: "idle" });
  const lastPhase = useRef<TxPhase>("idle");
  const txHash = useRef<string | undefined>(undefined);

  const update = useCallback((s: TxStatus) => {
    if (s.txHash) txHash.current = s.txHash;
    if (s.phase !== "failed") lastPhase.current = s.phase;
    setStatus({ ...s, txHash: s.txHash ?? txHash.current });
  }, []);

  const run = useCallback(
    async (fn: (update: (s: TxStatus) => void) => Promise<void>) => {
      txHash.current = undefined;
      lastPhase.current = "idle";
      try {
        await fn(update);
      } catch (err) {
        const message = err instanceof ApiError ? err.message : explainWalletError(err);
        setStatus({ phase: "failed", message, txHash: txHash.current });
      }
    },
    [update],
  );

  const reset = useCallback(() => {
    txHash.current = undefined;
    lastPhase.current = "idle";
    setStatus({ phase: "idle" });
  }, []);

  const busy = !["idle", "confirmed", "failed"].includes(status.phase);
  return { status, lastPhase: lastPhase.current, run, reset, busy, txHash: txHash.current };
}
