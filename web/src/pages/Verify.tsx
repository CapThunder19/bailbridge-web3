import { useCallback, useEffect, useState, type DragEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { deployment, explorerAddress, networkLabel, readRegistry } from "../lib/deployment";
import { hashFile } from "../lib/hash";
import { verify, type MilestoneView, type VerifyResult } from "../lib/verify";
import { formatUnix } from "../lib/format";
import { Card, Hash, Notice, Spinner } from "../components/ui";

const MILESTONE_LABEL: Record<string, string> = {
  THRESHOLD_FLAGGED: "Threshold flagged (registrar)",
  SUPERINTENDENT_APPLICATION: "Superintendent s.479(3) application (prison)",
  APPLICATION_FILED: "Bail application filed (lawyer)",
  ORDER_ATTESTED: "Order attested (Demo issuer)",
  ORDER_RECEIVED_BY_PRISON: "Order received (prison)",
  RELEASE_ACKNOWLEDGED: "Release acknowledged (prison)",
};

function Check({ ok, label, children }: { ok: boolean | null; label: string; children?: ReactNode }) {
  const style = ok === null ? "border-stone-200 bg-stone-50" : ok ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50";
  const icon = ok === null ? "–" : ok ? "✓" : "✗";
  const iconStyle = ok === null ? "bg-stone-300 text-stone-700" : ok ? "bg-emerald-700 text-white" : "bg-red-700 text-white";
  return (
    <div className={`flex gap-3 rounded-lg border p-4 ${style}`}>
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-lg font-bold ${iconStyle}`} aria-hidden>
        {icon}
      </span>
      <div>
        <p className="font-semibold">
          <span className="sr-only">{ok === null ? "Not checked: " : ok ? "Passed: " : "Failed: "}</span>
          {label}
        </p>
        {children && <div className="mt-1 text-[0.95rem] text-navy-800">{children}</div>}
      </div>
    </div>
  );
}

function Receipts({ milestones }: { milestones: MilestoneView[] }) {
  if (!milestones.length) return null;
  return (
    <Card title="Milestone receipts (on-chain)">
      <ol className="space-y-2">
        {milestones.map((m, i) => (
          <li key={i} className="rounded-lg bg-paper px-3 py-2 text-[0.95rem]">
            <div className="font-semibold">{MILESTONE_LABEL[m.milestone] ?? m.milestone}</div>
            <div className="text-sm text-stone-700">
              {formatUnix(m.timestamp)} · wallet <Hash value={m.actor} href={explorerAddress(m.actor)} />
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function Verify() {
  const [params] = useSearchParams();
  const orderId = params.get("order");
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const run = useCallback(
    async (fileHash: string | null) => {
      setBusy(true);
      try {
        setResult(await verify(readRegistry(), { fileHash, orderId }));
      } catch (err) {
        setResult({ kind: "rpc-unavailable", message: err instanceof Error ? err.message : "Lookup failed." });
      } finally {
        setBusy(false);
      }
    },
    [orderId],
  );

  useEffect(() => {
    setResult(null);
    setFileName(null);
    if (orderId) void run(null);
  }, [orderId, run]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    const { hash } = await hashFile(file); // computed locally — the file is never uploaded
    await run(hash);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    void onFile(e.dataTransfer.files[0]);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="font-serif text-3xl font-semibold">Verify a document</h1>
        <p className="mt-1 text-stone-700">
          Drop a BailBridge order or application PDF. It is hashed <strong>in your browser</strong> and never uploaded; the hash is compared with
          the registry {deployment ? `on ${networkLabel()}` : ""} through a public RPC.
        </p>
      </div>

      {!deployment ? (
        <Notice tone="warn" title="No registry is configured">
          This deployment runs in off-chain demo mode, so there is nothing on-chain to verify against.
        </Notice>
      ) : (
        <>
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
              dragging ? "border-gold-500 bg-gold-100" : "border-navy-200 bg-white hover:bg-navy-50"
            }`}
          >
            <span className="font-serif text-xl font-semibold">Drop a PDF here</span>
            <span className="mt-1 text-stone-600">or click to choose a file</span>
            {fileName && <span className="mt-3 font-mono text-sm text-navy-700">{fileName}</span>}
            <input type="file" accept="application/pdf,.pdf" className="sr-only" onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
          {orderId && (
            <p className="text-sm text-stone-600">
              Verification link for order <Hash value={orderId} />
            </p>
          )}
        </>
      )}

      {busy && <Spinner label="Checking the registry…" />}
      {result && !busy && <ResultView result={result} />}
    </div>
  );
}

function ResultView({ result }: { result: VerifyResult }) {
  switch (result.kind) {
    case "no-registry":
      return <Notice tone="warn">No registry is configured.</Notice>;
    case "invalid-input":
      return <Notice tone="warn">{result.message}</Notice>;
    case "rpc-unavailable":
      return (
        <Notice tone="error" title="RPC unavailable">
          {result.message} This is not the same as “not registered”.
        </Notice>
      );
    case "not-registered":
      return (
        <Notice tone="error" title="Not registered">
          {result.orderId
            ? "No order with this ID is registered in the registry."
            : "This file’s hash does not match any document registered in the registry. If it was meant to be a BailBridge document, it may have been altered."}
          {result.hash && (
            <p className="mt-2 text-sm">
              File hash: <Hash value={result.hash} />
            </p>
          )}
        </Notice>
      );
    case "structured-hash":
      return (
        <Notice tone="warn" title="Registered as a structured order record, not a PDF">
          This hash belongs to an order’s canonical JSON record. PDF bytes are only compared with registered PDF hashes.
        </Notice>
      );
    case "application":
      return (
        <div className="space-y-4">
          <Card title="Bail application">
            <div className="space-y-3">
              <Check ok label="File matches registered bytes">
                Registered as application #{result.application.appId}, filed {formatUnix(result.application.filedAt)}.
              </Check>
              <Check ok={result.lawyerAuthorised} label={result.lawyerAuthorised ? "Filed by a wallet holding the lawyer role" : "Filing wallet no longer holds the lawyer role"}>
                Wallet <Hash value={result.application.lawyer} href={explorerAddress(result.application.lawyer)} />
              </Check>
            </div>
            <p className="mt-3 text-sm text-stone-600">A filed application is a DRAFT-derived document lodged by a lawyer; it is not an order.</p>
          </Card>
          <Receipts milestones={result.milestones} />
        </div>
      );
    case "order": {
      const { order, fileMatches } = result;
      const active = order.status === "ACTIVE";
      return (
        <div className="space-y-4">
          <Card title="Order">
            {fileMatches === null && (
              <div className="mb-4">
                <Notice title="Record found — drop the PDF to verify the file">
                  The QR link identifies an order on the registry. Only comparing the PDF’s bytes proves the document in your hands is the registered one.
                </Notice>
              </div>
            )}
            <div className="space-y-3">
              <Check ok={fileMatches} label={fileMatches === null ? "File not yet checked" : fileMatches ? "File matches registered bytes" : "File does NOT match the registered bytes for this order"}>
                {fileMatches === false && "The dropped file differs from the PDF registered for this order (it may be altered or a different document). "}
                Registered PDF hash <Hash value={order.pdfHash} />
                {result.fileHash && (
                  <>
                    <br />
                    Your file’s hash <Hash value={result.fileHash} />
                  </>
                )}
              </Check>
              <Check ok={result.issuerAuthorised} label={result.issuerAuthorised ? "Attested by authorised Demo issuer" : "Issuer wallet does not (or no longer) hold the issuer role"}>
                Wallet <Hash value={order.issuer} href={explorerAddress(order.issuer)} /> · attested {formatUnix(order.attestedAt)}
              </Check>
              <Check ok={active} label={`Order status: ${order.status}`}>
                {active && "The order is ACTIVE on the registry."}
                {order.supersedes && (
                  <>
                    {" "}
                    It replaces earlier order <Hash value={order.supersedes} />.
                  </>
                )}
                {order.status === "REVOKED" && <>Revoked {formatUnix(order.statusChangedAt)}. The reason is recorded off-chain; only its commitment is on-chain.</>}
                {order.status === "SUPERSEDED" && (
                  <>
                    Superseded {formatUnix(order.statusChangedAt)} by order <Hash value={order.supersededBy} />.
                  </>
                )}
              </Check>
            </div>
            <div className="mt-4 text-sm text-stone-600">
              Order ID <Hash value={order.orderId} /> · structured record hash <Hash value={order.structuredOrderHash} /> (canonical JSON; stored
              separately from the PDF hash)
            </div>
          </Card>
          <Receipts milestones={result.milestones} />
          <p className="text-xs text-stone-500">
            The registry proves who attested which bytes and when. It does not prove the underlying facts are true, and “Demo issuer” is a
            prototype identity, not a real court.
          </p>
        </div>
      );
    }
  }
}
