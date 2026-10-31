import { useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { deployment, MILESTONE_INDEX } from "../../lib/deployment";
import { sendRegistryTx } from "../../lib/wallet";
import { useTxFlow } from "../../lib/useTxFlow";
import type { CaseDetail, User } from "../../lib/types";
import { todayIso } from "../../lib/format";
import { Button, Card, Field, Notice, inputClass } from "../ui";
import { TxStatusView } from "../TxStatusView";

type PrisonMilestone = "SUPERINTENDENT_APPLICATION" | "ORDER_RECEIVED_BY_PRISON" | "RELEASE_ACKNOWLEDGED";

const COPY: Record<PrisonMilestone, { title: string; help: string; button: string; noteHint: string }> = {
  SUPERINTENDENT_APPLICATION: {
    title: "Record the s.479(3) written application",
    help: "s.479(3) BNSS: on completion of the period, the Superintendent must forthwith make a written application to the Court for release. Record that it was made.",
    button: "Sign: s.479(3) application made",
    noteHint: "e.g. letter reference, date sent to court (kept off-chain; only a commitment is recorded)",
  },
  ORDER_RECEIVED_BY_PRISON: {
    title: "Acknowledge receipt of the order",
    help: "Confirm the prison has received the ACTIVE order. Receipt of a revoked or superseded order cannot be recorded.",
    button: "Sign: order received",
    noteHint: "e.g. inward register entry",
  },
  RELEASE_ACKNOWLEDGED: {
    title: "Acknowledge release",
    help: "Requires recorded receipt of the ACTIVE order. Confirm release under that order.",
    button: "Sign: release acknowledged",
    noteHint: "e.g. release register entry, time of release",
  },
};

function MilestoneForm({ detail, user, milestone, orderId, onChange }: { detail: CaseDetail; user: User; milestone: PrisonMilestone; orderId: string | null; onChange: () => void }) {
  const [note, setNote] = useState("");
  const [date, setDate] = useState(todayIso());
  const tx = useTxFlow();
  const copy = COPY[milestone];

  function submit(e: FormEvent) {
    e.preventDefault();
    void tx.run(async (update) => {
      const prep = await api.post<{ milestoneId: number; orderId: string; evidenceCommitment: string; milestoneIndex: number }>(
        `/cases/${detail.case.id}/milestones/prepare`,
        { milestone, orderId, note, date },
      );
      if (prep.milestoneIndex !== MILESTONE_INDEX[milestone]) throw new Error("Unexpected milestone index from server.");
      const txHash = await sendRegistryTx({
        method: "attestMilestone",
        args: [detail.case.id, prep.orderId, prep.milestoneIndex, prep.evidenceCommitment],
        role: "PRISON_ROLE",
        expectedAccount: user.walletAddress,
        onStatus: update,
      });
      update({ phase: "recording", txHash, message: "Server is checking the confirmed attestation…" });
      await api.post(`/milestones/${prep.milestoneId}/confirm`, { txHash });
      update({ phase: "confirmed", txHash, message: "Recorded on-chain." });
      onChange();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-paper-200 p-4">
      <h3 className="font-semibold">{copy.title}</h3>
      <p className="text-[0.95rem] text-stone-700">{copy.help}</p>
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <Field label="Date">
          <input className={inputClass} type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label="Note" hint={copy.noteHint}>
          <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <Button type="submit" disabled={tx.busy || tx.status.phase === "confirmed"}>
        {copy.button}
      </Button>
      <TxStatusView status={tx.status} lastPhase={tx.lastPhase} />
    </form>
  );
}

export function PrisonPanel({ detail, user, onChange }: { detail: CaseDetail; user: User; onChange: () => void }) {
  const steps = Object.fromEntries(detail.workflow.steps.map((s) => [s.milestone, s]));
  const active = detail.workflow.activeOrderId;
  const forms: { milestone: PrisonMilestone; orderId: string | null }[] = [];
  if (steps.SUPERINTENDENT_APPLICATION?.state === "open") forms.push({ milestone: "SUPERINTENDENT_APPLICATION", orderId: null });
  if (active && steps.ORDER_RECEIVED_BY_PRISON?.state === "open") forms.push({ milestone: "ORDER_RECEIVED_BY_PRISON", orderId: active });
  if (active && steps.RELEASE_ACKNOWLEDGED?.state === "open") forms.push({ milestone: "RELEASE_ACKNOWLEDGED", orderId: active });
  const revoked = detail.orders.some((o) => o.status === "REVOKED") && !active;

  return (
    <Card title="Prison superintendent: actions">
      {!deployment ? (
        <Notice tone="warn">Off-chain demo — prison attestations are disabled.</Notice>
      ) : forms.length === 0 ? (
        <p className="text-stone-600">
          {revoked ? "The order on this case was revoked; there is no ACTIVE order to acknowledge." : "No prison action is open on this case right now."}
        </p>
      ) : (
        <div className="space-y-4">
          {forms.map((f) => (
            <MilestoneForm key={f.milestone} detail={detail} user={user} milestone={f.milestone} orderId={f.orderId} onChange={onChange} />
          ))}
        </div>
      )}
    </Card>
  );
}
