import { loadConfig, type AppConfig } from "./config.js";
import { ChainService } from "./chain.js";
import { openDb } from "./db.js";
import { demoUsers, ensureDemoUsers } from "./auth.js";
import { loadOffences } from "./screening/offences.js";
import { todayIso } from "./screening/dates.js";
import type { Ctx } from "./services/context.js";

/** Build the application context (DB, chain, offence data) and ensure demo users exist. */
export function bootstrap(config: AppConfig = loadConfig()): Ctx {
  const db = openDb(config.dbPath);
  const chain = config.chain ? new ChainService(config.chain) : null;
  ensureDemoUsers(db, demoUsers(config.demoWallets), config.demoPassword);
  return { db, config, chain, offences: loadOffences(), today: () => todayIso() };
}
