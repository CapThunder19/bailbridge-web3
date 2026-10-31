import QRCode from "qrcode";
import { Flow } from "./layout.js";

/** Canonical structured order (hashed as keccak256(canonicalJson(order))). */
export interface StructuredOrder {
  schema: "bailbridge.order.v1";
  orderId: string;
  caseId: string;
  chainApplicationId: number;
  applicationPdfHash: string;
  court: string;
  caseRef: string;
  applicantName: string;
  orderDate: string;
  decision: string;
  conditions: string[];
  bondAmountInr: number | null;
  issuerName: string;
  issuerWallet: string;
  legalProvision: string;
  synthetic: true;
}

export function verifyUrl(publicWebUrl: string, orderId: string): string {
  return `${publicWebUrl}/verify?order=${orderId}`;
}

/**
 * Render the order PDF. The QR (pointing to /verify?order=<orderId>) is drawn
 * BEFORE saving; the caller hashes the final saved bytes. The PDF never contains
 * its own hash, and the structured hash is shown only as a separate value.
 */
export async function buildOrderPdf(order: StructuredOrder, structuredHash: string, url: string): Promise<Uint8Array> {
  const f = await Flow.create("DEMO");
  const when = new Date(`${order.orderDate}T00:00:00Z`);
  f.doc.setTitle(`Demo order ${order.orderId.slice(0, 10)} — ${order.caseRef}`);
  f.doc.setSubject("Synthetic demo order issued by a Demo court issuer identity. Not a real court order.");
  f.doc.setProducer("BailBridge prototype");
  f.doc.setCreator("BailBridge prototype");
  f.doc.setCreationDate(when);
  f.doc.setModificationDate(when);

  f.text("SYNTHETIC DEMO ORDER — NOT A REAL COURT ORDER", { bold: true, color: "red", size: 10 });
  f.text("Issued by a Demo court issuer identity in the BailBridge prototype.", { color: "grey", size: 9, gap: 12 });

  f.text(`IN THE COURT OF ${order.court.toUpperCase()} (DEMO)`, { bold: true, size: 13 });
  f.text(`Case reference: ${order.caseRef}`, { gap: 10 });
  f.text("ORDER ON APPLICATION UNDER SECTION 479, BHARATIYA NAGARIK SURAKSHA SANHITA, 2023", { bold: true, size: 12, gap: 10 });

  f.rows([
    ["Order ID", order.orderId],
    ["Order date", order.orderDate],
    ["Applicant", order.applicantName],
    ["Application (on-chain ID)", `#${order.chainApplicationId}`],
    ["Application PDF hash", order.applicationPdfHash],
  ], 150);

  f.heading("Order");
  f.text(order.decision, { gap: 8 });
  if (order.bondAmountInr !== null) f.text(`Bond amount: Rs ${order.bondAmountInr.toLocaleString("en-IN")}`, { gap: 8 });
  if (order.conditions.length) {
    f.heading("Conditions");
    order.conditions.forEach((c, i) => f.text(`${i + 1}. ${c}`, { indent: 10 }));
  }

  f.y -= 8;
  f.text(`${order.issuerName}`, { bold: true });
  f.text(`Issuer wallet: ${order.issuerWallet}`, { size: 9, color: "grey", gap: 14 });

  // QR to the public verification page (drawn before the final save).
  const qrPng = await QRCode.toBuffer(url, { type: "png", margin: 1, width: 220, errorCorrectionLevel: "M" });
  const qr = await f.doc.embedPng(qrPng);
  const size = 120;
  if (f.y - size < f.margin + 40) f.newPage();
  const top = f.y;
  f.page.drawImage(qr, { x: f.margin, y: top - size, width: size, height: size });
  const textX = f.margin + size + 14;
  const lines = [
    "Verify this order",
    "Scan the QR code or open:",
    url,
    "Then drop this PDF on the verify page: it is hashed in your browser",
    "and compared with the bytes registered on-chain.",
    `Structured order hash: ${structuredHash}`,
  ];
  let ly = top - 12;
  for (const [i, line] of lines.entries()) {
    for (const wrapped of f.wrap(line, i === 0 ? 11 : 8.5, i === 0 ? f.bold : f.font, f.contentWidth - size - 14)) {
      f.page.drawText(wrapped, { x: textX, y: ly, size: i === 0 ? 11 : 8.5, font: i === 0 ? f.bold : f.font });
      ly -= i === 0 ? 15 : 11;
    }
  }
  f.y = top - size - 10;

  f.footer(`BailBridge DEMO order ${order.orderId.slice(0, 10)}… — synthetic data — not a real court order`);
  return f.doc.save();
}
