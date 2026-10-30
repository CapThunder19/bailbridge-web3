import { hexlify, keccak256, randomBytes, toUtf8Bytes } from "ethers";
import { canonicalJson } from "./canonical.js";

export type Hex32 = `0x${string}`;

/** keccak256 of exact bytes (used for PDFs). */
export function hashBytes(bytes: Uint8Array): Hex32 {
  return keccak256(bytes) as Hex32;
}

/** keccak256 of the canonical JSON form of a value (used for structured orders). */
export function hashCanonicalJson(value: unknown): Hex32 {
  return keccak256(toUtf8Bytes(canonicalJson(value))) as Hex32;
}

/** Random 32-byte value as 0x-hex (case IDs, order IDs, salts). */
export function randomBytes32(): Hex32 {
  return hexlify(randomBytes(32)) as Hex32;
}

/** True when the given bytes hash to the registered value (case-insensitive hex compare). */
export function bytesMatchHash(bytes: Uint8Array, registeredHash: string): boolean {
  return hashBytes(bytes).toLowerCase() === registeredHash.toLowerCase();
}

/**
 * Salted commitment to an off-chain record:
 *   keccak256( utf8( "bailbridge:" + kind + ":" + secret + ":" + salt + ":" + canonicalJson({ v, kind, data }) ) )
 *
 * - `secret` is a server-side secret, so third parties cannot brute-force
 *   low-entropy records (names, dates) from the on-chain value.
 * - `salt` is unique per record, so identical records yield different commitments.
 * - `version` lets the payload format change without ambiguity.
 *
 * A commitment proves an off-chain record is CONSISTENT with what was anchored;
 * it says nothing about whether the record is TRUE.
 */
export function computeCommitment(params: {
  secret: string;
  salt: string;
  kind: string;
  version: number;
  data: unknown;
}): Hex32 {
  const { secret, salt, kind, version, data } = params;
  if (!secret) throw new Error("commitment secret is required");
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error("salt must be 32 bytes hex");
  if (!/^[a-z][a-z0-9_.-]*$/.test(kind)) throw new Error("invalid commitment kind");
  const body = canonicalJson({ v: version, kind, data });
  return keccak256(toUtf8Bytes(`bailbridge:${kind}:${secret}:${salt}:${body}`)) as Hex32;
}
