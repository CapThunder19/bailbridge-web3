import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { hashBytes } from "../../lib/hash";
import { deployment } from "../../lib/deployment";
import { sendRegistryTx } from "../../lib/wallet";
import { useTxFlow } from "../../lib/useTxFlow";
import type { CaseDetail, User } from "../../lib/types";
import { formatUnix } from "../../lib/format";
import { Button, Card, Hash, Notice } from "../ui";
import { TxStatusView } from "../TxStatusView";

/**
 * Lawyer filing: generate DRAFT → review → browser hashes exact bytes → sign
 * fileApplication(caseId, pdfHash) → upload the same bytes → server re-verifies.
 */
export function LawyerPanel({ detail, user, onChange }: { detail: CaseDetail; user: User; onChange: () => void }) {
  const [draft, setDraft] = useState<{ bytes: Uint8Array; hash: string; url: string } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [filedTx, setFiledTx] = useState<string | null>(null);
  const tx = useTxFlow();
  const caseId = detail.case.id;
  const reached = detail.screening.status === "THRESHOLD_REACHED_REVIEW_REQUIRED";
  const anchored = detail.case.chainStatus === "anchored";

  useEffect(() => () => (draft ? URL.revokeObjectURL(draft.url) : undefined), [draft]);

  async function generate() {
    setLoadingDraft(true);
    setDraftError(null);
    setReviewed(false);
    tx.reset();
    setFiledTx(null);
    try {
      const bytes = await api.bytes(`/cases/${caseId}/application-draft.pdf`);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
      setDraft({ bytes, hash: hashBytes(bytes), url });
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : "Could not generate the draft.");
    } finally {
      setLoadingDraft(false);
    }
  }

  async function upload(txHash: string, bytes: Uint8Array, update: Parameters<Parameters<typeof tx.run>[0]>[0]) {
    update({ phase: "recording", txHash, message: "Uploading the same bytes; the server recomputes the hash and checks the on-chain record…" });
    await api.uploadPdf(`/cases/${caseId}/applications?txHash=${txHash}`, bytes);
    update({ phase: "confirmed", txHash, message: "Application filed and verified against the on-chain record." });
    setDraft(null);
    onChange();
  }

  function file() {
    if (!draft) return;
    const { bytes, hash } = draft;
    void tx.run(async (update) => {
      const txHash = await sendRegistryTx({
        method: "fileApplication",
        args: [caseId, hash],
        role: "LAWYER_ROLE",
        expectedAccount: user.walletAddress,
        onStatus: update,
      });
      setFiledTx(txHash);
      await upload(txHash, bytes, update);
    });
  }

  function retryUpload() {
    if (!draft || !filedTx) return;
    const { bytes } = draft;
    void tx.run((update) => upload(filedTx, bytes, update));
  }

  return (
    <Card title="Lawyer: s.479 bail application">
      {detail.applications.length > 0 && (
        <div className="mb-5 space-y-3">
          {detail.applications.map((a) => (
            <div key={a.id} className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-[0.95rem]">
              <p className="font-semibold text-emerald-900">Application #{a.chainAppId} filed {formatUnix(a.chainTimestamp)}</p>
              <p className="mt-1">
                PDF hash <Hash value={a.pdfHash} /> · Tx <Hash value={a.txHash} href={a.explorerUrl} />
              </p>
              <a className="mt-1 inline-block text-sm font-semibold text-navy-700 underline" href={`/api/applications/${a.id}/pdf`} target="_blank" rel="noreferrer">
                Open filed PDF
              </a>
            </div>
          ))}
        </div>
      )}

      {!reached ? (
        <Notice>A s.479 draft becomes available once the screening threshold has been reached.</Notice>
      ) : (
        <div className="space-y-4">
          <ol className="list-decimal space-y-1 pl-5 text-[0.95rem] text-stone-700">
            <li>Generate the clearly marked DRAFT and review it.</li>
            <li>Your browser computes keccak256 of the exact bytes.</li>
            <li>Sign <code className="font-mono">fileApplication(caseId, pdfHash)</code> in MetaMask.</li>
            <li>The same bytes are uploaded; the server recomputes the hash and checks the confirmed on-chain record and your wallet.</li>
          </ol>
          <Button variant="secondary" onClick={generate} disabled={loadingDraft || tx.busy}>
            {loadingDraft ? "Generating…" : draft ? "Regenerate draft" : "Generate DRAFT application PDF"}
          </Button>
          {draftError && <Notice tone="error">{draftError}</Notice>}
          {draft && (
            <div className="space-y-3 rounded-lg bg-paper p-4">
              <p className="text-[0.95rem]">
                <a href={draft.url} target="_blank" rel="noreferrer" className="font-semibold text-navy-700 underline">
                  Open draft PDF
                </a>{" "}
                <span className="text-stone-600">({(draft.bytes.length / 1024).toFixed(1)} KB)</span>
              </p>
              <p className="text-[0.95rem]">
                keccak256 (computed in your browser): <Hash value={draft.hash} />
              </p>
              <label className="flex items-start gap-2 text-[0.95rem]">
                <input type="checkbox" className="mt-1 h-5 w-5" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
                I have reviewed the draft, its calculation and caveats.
              </label>
              {!deployment ? (
                <Notice tone="warn">Off-chain demo — filing on-chain is disabled.</Notice>
              ) : !anchored ? (
                <Notice tone="warn">Waiting for the case to be anchored on-chain before filing ({detail.case.chainStatus}).</Notice>
              ) : null}
              <div className="flex flex-wrap gap-3">
                <Button onClick={file} disabled={!reviewed || !deployment || !anchored || tx.busy || tx.status.phase === "confirmed"}>
                  Sign and file on-chain
                </Button>
                {tx.status.phase === "failed" && filedTx && (
                  <Button variant="secondary" onClick={retryUpload}>
                    Retry upload (transaction already confirmed)
                  </Button>
                )}
              </div>
            </div>
          )}
          <TxStatusView status={tx.status} lastPhase={tx.lastPhase} />
        </div>
      )}
    </Card>
  );
}
