import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import type { Express } from "express";
import { loadConfig, type AppConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { demoUsers, ensureDemoUsers } from "../src/auth.js";
import { loadOffences } from "../src/screening/offences.js";
import { ChainService } from "../src/chain.js";
import type { Ctx } from "../src/services/context.js";
import { addDays } from "../src/screening/dates.js";

export const TODAY = "2026-10-30";
export const PASSWORD = "test-password";

export function testCtx(overrides: Partial<AppConfig> = {}): Ctx {
  const base = loadConfig({ CHAIN_DISABLED: "true", COMMITMENT_SECRET: "test-secret", DEMO_PASSWORD: PASSWORD });
  const config: AppConfig = {
    ...base,
    dbPath: ":memory:",
    storageDir: mkdtempSync(path.join(tmpdir(), "bailbridge-test-")),
    publicWebUrl: "http://localhost:5173",
    webDistDir: path.join(tmpdir(), "bailbridge-no-web-dist"),
    gemini: { apiKey: null, model: "test" },
    ...overrides,
  };
  const db = openDb(":memory:");
  ensureDemoUsers(db, demoUsers(config.demoWallets), PASSWORD);
  return {
    db,
    config,
    chain: config.chain ? new ChainService(config.chain) : null,
    offences: loadOffences(),
    today: () => TODAY,
  };
}

export async function login(app: Express, username: string) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

/** Case input whose ongoing custody has lasted `days` days (inclusive) as of TODAY. */
export function caseInput(days: number, overrides: Record<string, unknown> = {}) {
  return {
    personName: "Demo Person (synthetic)",
    age: 31,
    caseRef: "SYN/TEST/001",
    court: "Demo Sessions Court, Synthetic District",
    stage: "Trial — prosecution evidence",
    offenceId: "bns-303-2-first", // threshold 548 days at one-half
    custodyPeriods: [{ start: addDays(TODAY, -(days - 1)), end: null }],
    previousConviction: "yes",
    otherPendingCases: "no",
    excludedDays: 0,
    excludedNote: "",
    ...overrides,
  };
}
