import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { hashBytes } from "../../lib/hash";
import { deployment } from "../../lib/deployment";
import { sendRegistryTx, WalletError } from "../../lib/wallet";
import { useTxFlow } from "../../lib/useTxFlow";
import type { CaseDetail, User } from "../../lib/types";
import { formatUnix, todayIso } from "../../lib/format";
import { Button, Card, Field, Hash, Notice, inputClass } from "../ui";
import { TxStatusView } from "../TxStatusView";

type Order = CaseDetail["orders"][number];

const STATUS_STYLE: Record<Order["status"], string> = {
  PREPARED: "bg-stone-100 text-stone-700",
  ACTIVE: "bg-emerald-100 text-emerald-900",
  REVOKED: "bg-red-100 text-red-900",
  SUPERSEDED: "bg-stone-200 text-stone-800",
};

interface Prepared {
  orderId: string;
  caseId: string;
  chainAppId: number;
  structuredHash: string;
  pdfHash: string;
  verifyUrl: string;
}

function AttestForm({ detail, user, applicationId, onChange }: { detail: CaseDetail; user: User; applicationId: number; onChange: () => void }) {
  const [decision, setDecision] = useState(
    "Upon consideration of the application under Section 479 of the Bharatiya Nagarik Suraksha Sanhita, 2023, and the record of detention, the applicant is admitted to bail on executing a personal bond.",
  );
  const [conditions, setConditions] = useState("Shall appear before the Court on every date of hearing.\nShall not leave the district without prior permission of the Court.");
  const [bond, setBond] = useState("10000");
  const [orderDate, setOrderDate] = useState(todayIso());
  const tx = useTxFlow();

  function submit(e: FormEvent) {
    e.preventDefault();
    void tx.run(async (update) => {
      update({ phase: "checking", message: "Preparing order JSON and PDF (QR first, then hashing the final bytes)…" });
      const prep = await api.post<Prepared>(`/cases/${detail.case.id}/orders/prepare`, {
        applicationId,
        decision,
        conditions: conditions.split("\n").map((c) => c.trim()).filter(Boolean),
        bondAmountInr: bond === "" ? null : Number(bond),
        orderDate,
      });
      // Independently hash the exact final PDF bytes in the browser before signing.
      const bytes = await api.bytes(`/orders/${prep.orderId}/pdf`);
      const localHash = hashBytes(bytes);
      if (localHash.toLowerCase() !== prep.pdfHash.toLowerCase()) {
        throw new WalletError("The PDF you downloaded does not match the hash the server prepared. Not signing.");
      }
      const txHash = await sendRegistryTx({
        method: "attestOrder",
        args: [detail.case.id, prep.chainAppId, prep.orderId, prep.structuredHash, localHash],
        role: "ISSUER_ROLE",
        expectedAccount: user.walletAddress,
        onStatus: update,
      });
      update({ phase: "recording", txHash, message: "Server is checking the confirmed attestation…" });
      await api.post(`/orders/${prep.orderId}/confirm`, { txHash });
      update({ phase: "confirmed", txHash, message: "Order attested and ACTIVE." });
      onChange();
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-paper-200 p-4">
      <h3 className="font-semibold">Attest an order on application #{detail.applications.find((a) => a.id === applicationId)?.chainAppId}</h3>
      <Field label="Order text (synthetic)">
        <textarea className={`${inputClass} min-h-28`} value={decision} onChange={(e) => setDecision(e.target.value)} required minLength={10} />
      </Field>
      <Field label="Conditions" hint="One per line.">
        <textarea className={`${inputClass} min-h-20`} value={conditions} onChange={(e) => setConditions(e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Bond amount (Rs)">
          <input className={inputClass} type="number" min={0} value={bond} onChange={(e) => setBond(e.target.value)} />
        </Field>
        <Field label="Order date">
          <input className={inputClass} type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} required />
        </Field>
      </div>
      <p className="text-sm text-stone-600">
        Two hashes are attested separately: <strong>structuredOrderHash</strong> = keccak256 of the canonical order JSON, and <strong>pdfHash</strong> =
        keccak256 of the final PDF bytes (which contain a QR link to /verify — never the PDF’s own hash).
      </p>
      <Button type="submit" disabled={tx.busy || tx.status.phase === "confirmed"}>
        Prepare, sign and attest order
      </Button>
      <TxStatusView status={tx.status} lastPhase={tx.lastPhase} />
    </form>
  );
}

function RevokeForm({ order, user, onChange }: { order: Order; user: User; onChange: () => void }) {
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const tx = useTxFlow();

  function submit(e: FormEvent) {
    e.preventDefault();
    void tx.run(async (update) => {
      const { reasonCommitment } = await api.post<{ reasonCommitment: string }>(`/orders/${order.orderId}/revoke/prepare`, { reason });
      const txHash = await sendRegistryTx({
        method: "revokeOrder",
        args: [order.orderId, reasonCommitment],
        role: "ISSUER_ROLE",
        expectedAccount: user.walletAddress,
        onStatus: update,
      });
      update({ phase: "recording", txHash, message: "Server is checking the confirmed revocation…" });
      await api.post(`/orders/${order.orderId}/revoke/confirm`, { txHash });
      update({ phase: "confirmed", txHash, message: "Order revoked. History remains on the log." });
      onChange();
    });
  }

  if (!open) {
    return (
      <Button variant="secondary" className="mt-2" onClick={() => setOpen(true)}>
        Revoke this order…
      </Button>
    );
  }
  return (
    <form onSubmit={submit} className="mt-3 space-y-3">
      <Field label="Reason for revocation" hint="Kept off-chain; only a salted commitment is recorded.">
        <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={tx.busy || tx.status.phase === "confirmed"}>
          Sign revocation
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={tx.busy}>
          Cancel
        </Button>
      </div>
      <TxStatusView status={tx.status} lastPhase={tx.lastPhase} />
    </form>
  );
}

/**
 * P1: replace an ACTIVE order with a corrected one. The old order stays on the log as
 * SUPERSEDED with an append-only link old -> new; the prison must acknowledge the new order.
 */
function SupersedeForm({ order, user, onChange }: { order: Order; user: User; onChange: () => void }) {
  const prev = order.structured as { decision?: string; conditions?: string[]; bondAmountInr?: number | null };
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState(prev.decision ?? "");
  const [conditions, setConditions] = useState((prev.conditions ?? []).join("\n"));
  const [bond, setBond] = useState(prev.bondAmountInr == null ? "" : String(prev.bondAmountInr));
  const [orderDate, setOrderDate] = useState(todayIso());
  const [reason, setReason] = useState("");
  const tx = useTxFlow();

  function submit(e: FormEvent) {
    e.preventDefault();
    void tx.run(async (update) => {
      update({ phase: "checking", message: "Preparing the replacement order JSON and PDF…" });
      const prep = await api.post<Prepared & { supersedes: string; reasonCommitment: string }>(`/orders/${order.orderId}/supersede/prepare`, {
        decision,
        conditions: conditions.split("\n").map((c) => c.trim()).filter(Boolean),
        bondAmountInr: bond === "" ? null : Number(bond),
        orderDate,
        reason,
      });
      const bytes = await api.bytes(`/orders/${prep.orderId}/pdf`);
      const localHash = hashBytes(bytes);
      if (localHash.toLowerCase() !== prep.pdfHash.toLowerCase()) {
        throw new WalletError("The PDF you downloaded does not match the hash the server prepared. Not signing.");
      }
      const txHash = await sendRegistryTx({
        method: "supersedeOrder",
        args: [order.orderId, prep.orderId, prep.structuredHash, localHash, prep.reasonCommitment],
        role: "ISSUER_ROLE",
        expectedAccount: user.walletAddress,
        onStatus: update,
      });
      update({ phase: "recording", txHash, message: "Server is checking the confirmed supersession…" });
      await api.post(`/orders/${prep.orderId}/supersede/confirm`, { txHash });
      update({ phase: "confirmed", txHash, message: "Replacement order is ACTIVE; the previous order is SUPERSEDED." });
      onChange();
    });
  }

  if (!open) {
    return (
      <Button variant="secondary" className="mt-2" onClick={() => setOpen(true)}>
        Supersede with a corrected order…
      </Button>
    );
  }
  return (
    <form onSubmit={submit} className="mt-3 w-full space-y-3 rounded-lg border border-paper-200 p-4">
      <h3 className="font-semibold">Replacement order</h3>
      <Field label="Order text (synthetic)">
        <textarea className={`${inputClass} min-h-24`} value={decision} onChange={(e) => setDecision(e.target.value)} required minLength={10} />
      </Field>
      <Field label="Conditions" hint="One per line.">
        <textarea className={`${inputClass} min-h-16`} value={conditions} onChange={(e) => setConditions(e.target.value)} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Bond amount (Rs)">
          <input className={inputClass} type="number" min={0} value={bond} onChange={(e) => setBond(e.target.value)} />
        </Field>
        <Field label="Order date">
          <input className={inputClass} type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} required />
        </Field>
      </div>
      <Field label="Reason for replacing the order" hint="Kept off-chain; only a salted commitment is recorded.">
        <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" disabled={tx.busy || tx.status.phase === "confirmed"}>
          Prepare, sign and supersede
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={tx.busy}>
          Cancel
        </Button>
      </div>
      <TxStatusView status={tx.status} lastPhase={tx.lastPhase} />
    </form>
  );
}

/** Orders on the case (visible to all roles) with issuer actions. */
export function OrdersCard({ detail, user, onChange }: { detail: CaseDetail; user: User; onChange: () => void }) {
  const isIssuer = user.role === "issuer";
  const visibleOrders = detail.orders.filter((o) => o.status !== "PREPARED");
  const awaiting = detail.applications.filter((a) => !a.hasOrder);
  if (!visibleOrders.length && !(isIssuer && detail.applications.length)) return null;

  return (
    <Card title={isIssuer ? "Demo court issuer: orders" : "Orders"}>
      {visibleOrders.length > 0 && (
        <ul className="space-y-3">
          {visibleOrders.map((o) => (
            <li key={o.orderId} className="rounded-lg border border-paper-200 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2.5 py-0.5 text-sm font-semibold ${STATUS_STYLE[o.status]}`}>{o.status}</span>
                <span className="text-[0.95rem]">
                  Order <Hash value={o.orderId} /> · attested {formatUnix(o.chainTimestamp)}
                </span>
              </div>
              <div className="mt-2 space-y-1 text-sm text-stone-700">
                <p>
                  PDF hash <Hash value={o.pdfHash} /> · structured hash <Hash value={o.structuredHash} />
                </p>
                <p>
                  Tx <Hash value={o.txHash} href={o.explorerUrl} /> · issuer <Hash value={o.issuerWallet} />
                </p>
                {o.status === "REVOKED" && (
                  <p className="text-red-900">
                    Revoked {formatUnix(o.revokedAt)}
                    {o.revokeReason ? ` — ${o.revokeReason}` : ""}
                  </p>
                )}
                {o.supersededBy && (
                  <p className="text-stone-800">
                    Superseded by order <Hash value={o.supersededBy} />
                  </p>
                )}
                {o.supersedes && (
                  <p className="text-stone-800">
                    Replaces order <Hash value={o.supersedes} />
                    {o.supersedeReason ? ` — ${o.supersedeReason}` : ""}
                  </p>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-4 text-sm font-semibold">
                <a className="text-navy-700 underline" href={`/api/orders/${o.orderId}/pdf`} target="_blank" rel="noreferrer">
                  Open order PDF
                </a>
                <Link className="text-navy-700 underline" to={`/verify?order=${o.orderId}`}>
                  Public verification page
                </Link>
              </div>
              {isIssuer && o.status === "ACTIVE" && deployment && (
                <div className="flex flex-wrap gap-x-3">
                  <RevokeForm order={o} user={user} onChange={onChange} />
                  <SupersedeForm order={o} user={user} onChange={onChange} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {isIssuer && (
        <div className={visibleOrders.length ? "mt-5" : ""}>
          {!deployment ? (
            <Notice tone="warn">Off-chain demo — order attestation is disabled.</Notice>
          ) : awaiting.length === 0 ? (
            <p className="text-sm text-stone-600">No filed application is awaiting an order.</p>
          ) : (
            awaiting.map((a) => <AttestForm key={a.id} detail={detail} user={user} applicationId={a.id} onChange={onChange} />)
          )}
        </div>
      )}
    </Card>
  );
}
