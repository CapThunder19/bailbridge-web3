import { describe, expect, it } from "vitest";
import { hashBytes, hashFile } from "./hash";

describe("browser hashing", () => {
  it("matches the standard keccak256 test vector", () => {
    expect(hashBytes(new TextEncoder().encode("abc"))).toBe(
      "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
  });

  it("hashes a file's exact bytes and detects a one-byte change", async () => {
    const original = new TextEncoder().encode("%PDF-1.7 synthetic");
    const tampered = Uint8Array.from(original);
    tampered[5] = tampered[5]! ^ 0x01;
    const a = await hashFile(new Blob([original]));
    const b = await hashFile(new Blob([tampered]));
    expect(a.hash).toBe(hashBytes(original));
    expect(a.hash).not.toBe(b.hash);
  });
});
