import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { canonicalJson } from "../src/lib/canonical.js";
import { bytesMatchHash, computeCommitment, hashBytes, hashCanonicalJson, randomBytes32 } from "../src/lib/hashing.js";

async function makePdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText(text, { x: 50, y: 700, size: 12, font });
  return doc.save();
}

describe("PDF byte hashing", () => {
  it("accepts the original PDF bytes", async () => {
    const pdf = await makePdf("DRAFT bail application — synthetic");
    const registered = hashBytes(pdf);
    expect(registered).toMatch(/^0x[0-9a-f]{64}$/);
    expect(bytesMatchHash(pdf, registered)).toBe(true);
    expect(bytesMatchHash(Uint8Array.from(pdf), registered.toUpperCase().replace("0X", "0x"))).toBe(true);
  });

  it("rejects a PDF with a single modified byte", async () => {
    const pdf = await makePdf("Order — synthetic");
    const registered = hashBytes(pdf);
    for (const index of [0, Math.floor(pdf.length / 2), pdf.length - 1]) {
      const tampered = Uint8Array.from(pdf);
      tampered[index] = tampered[index]! ^ 0x01;
      expect(bytesMatchHash(tampered, registered)).toBe(false);
    }
  });

  it("rejects a PDF with one byte appended", async () => {
    const pdf = await makePdf("Order — synthetic");
    const extended = new Uint8Array(pdf.length + 1);
    extended.set(pdf);
    expect(bytesMatchHash(extended, hashBytes(pdf))).toBe(false);
  });
});

describe("canonical JSON", () => {
  it("is independent of key order", () => {
    const a = { b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" } };
    const b = { a: { c: "x", d: [1, { y: 2, z: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
    expect(hashCanonicalJson(a)).toBe(hashCanonicalJson(b));
  });

  it("drops undefined and rejects non-finite numbers", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });

  it("structured-order hash differs from the hash of a PDF of the same order", async () => {
    const order = { orderId: randomBytes32(), decision: "Bail granted on bond (synthetic)" };
    const pdf = await makePdf(canonicalJson(order));
    expect(hashCanonicalJson(order)).not.toBe(hashBytes(pdf));
  });
});

describe("salted commitments", () => {
  const secret = "test-secret";
  const data = { name: "Demo Person", caseRef: "SYN/2026/001" };

  it("is deterministic for the same secret, salt and data", () => {
    const salt = randomBytes32();
    const c1 = computeCommitment({ secret, salt, kind: "case.record", version: 1, data });
    const c2 = computeCommitment({ secret, salt, kind: "case.record", version: 1, data: { ...data } });
    expect(c1).toBe(c2);
  });

  it("changes with salt, secret, version, kind or data", () => {
    const salt = randomBytes32();
    const base = computeCommitment({ secret, salt, kind: "case.record", version: 1, data });
    expect(computeCommitment({ secret, salt: randomBytes32(), kind: "case.record", version: 1, data })).not.toBe(base);
    expect(computeCommitment({ secret: "other", salt, kind: "case.record", version: 1, data })).not.toBe(base);
    expect(computeCommitment({ secret, salt, kind: "case.record", version: 2, data })).not.toBe(base);
    expect(computeCommitment({ secret, salt, kind: "case.screening", version: 1, data })).not.toBe(base);
    expect(
      computeCommitment({ secret, salt, kind: "case.record", version: 1, data: { ...data, caseRef: "SYN/2026/002" } }),
    ).not.toBe(base);
  });

  it("validates inputs", () => {
    expect(() => computeCommitment({ secret: "", salt: randomBytes32(), kind: "k", version: 1, data })).toThrow();
    expect(() => computeCommitment({ secret, salt: "0x1234", kind: "k", version: 1, data })).toThrow(/salt/);
  });

  it("random IDs are 32-byte hex and unique", () => {
    const ids = new Set(Array.from({ length: 50 }, randomBytes32));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
