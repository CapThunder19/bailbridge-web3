import type { AppConfig } from "../config.js";
import type { ChainService } from "../chain.js";
import type { DB } from "../db.js";
import type { OffenceVariant } from "../screening/offences.js";
import { computeCommitment, randomBytes32, type Hex32 } from "../lib/hashing.js";

export interface Ctx {
  db: DB;
  config: AppConfig;
  chain: ChainService | null;
  offences: OffenceVariant[];
  /** Injectable clock for tests (YYYY-MM-DD). */
  today: () => string;
}

/** A domain error carrying an HTTP status and a plain-language message. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const COMMITMENT_VERSION = 1;

/** Salted commitment with a fresh per-record salt. */
export function commit(ctx: Ctx, kind: string, data: unknown): { salt: Hex32; commitment: Hex32 } {
  const salt = randomBytes32();
  return {
    salt,
    commitment: computeCommitment({ secret: ctx.config.commitmentSecret, salt, kind, version: COMMITMENT_VERSION, data }),
  };
}

/** Recompute a stored commitment (consistency check). */
export function recommit(ctx: Ctx, kind: string, salt: string, data: unknown): Hex32 {
  return computeCommitment({ secret: ctx.config.commitmentSecret, salt, kind, version: COMMITMENT_VERSION, data });
}
