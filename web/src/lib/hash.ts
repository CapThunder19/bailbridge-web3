import { keccak256 } from "ethers";

/** keccak256 of exact bytes, computed locally in the browser (files are never uploaded for verification). */
export function hashBytes(bytes: Uint8Array): string {
  return keccak256(bytes);
}

export async function hashFile(file: Blob): Promise<{ hash: string; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { hash: hashBytes(bytes), bytes };
}
