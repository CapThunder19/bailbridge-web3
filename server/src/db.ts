import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('caseworker','lawyer','issuer','prison')),
  display_name TEXT NOT NULL,
  wallet_address TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,                -- random bytes32 case ID (also used on-chain)
  person_name TEXT NOT NULL,
  age INTEGER,
  case_ref TEXT NOT NULL,
  court TEXT NOT NULL,
  stage TEXT NOT NULL,
  offence_id TEXT NOT NULL,
  custody_json TEXT NOT NULL,
  previous_conviction TEXT NOT NULL,
  other_pending TEXT NOT NULL,
  excluded_days INTEGER NOT NULL DEFAULT 0,
  excluded_note TEXT NOT NULL DEFAULT '',
  record_salt TEXT NOT NULL,
  record_commitment TEXT NOT NULL,
  register_tx TEXT,
  chain_status TEXT NOT NULL DEFAULT 'offchain', -- offchain | pending | anchored | failed
  chain_error TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS screening_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(id),
  snapshot_json TEXT NOT NULL,
  salt TEXT NOT NULL,
  commitment TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  tx_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(id),
  chain_app_id INTEGER NOT NULL,
  pdf_hash TEXT NOT NULL UNIQUE,
  pdf_path TEXT NOT NULL,
  lawyer_user_id INTEGER NOT NULL REFERENCES users(id),
  lawyer_wallet TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  block_number INTEGER NOT NULL,
  chain_timestamp INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,          -- random bytes32
  case_id TEXT NOT NULL REFERENCES cases(id),
  application_id INTEGER NOT NULL REFERENCES applications(id),
  structured_json TEXT NOT NULL,
  structured_hash TEXT NOT NULL,
  pdf_hash TEXT NOT NULL,
  pdf_path TEXT NOT NULL,
  status TEXT NOT NULL,               -- PREPARED | ACTIVE | REVOKED | SUPERSEDED
  issuer_user_id INTEGER NOT NULL REFERENCES users(id),
  issuer_wallet TEXT,
  tx_hash TEXT UNIQUE,
  block_number INTEGER,
  chain_timestamp INTEGER,
  revoke_reason TEXT,
  revoke_salt TEXT,
  revoke_commitment TEXT,
  revoke_tx TEXT,
  revoked_at INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(id),
  milestone TEXT NOT NULL,
  order_id TEXT,
  application_id INTEGER,
  evidence_json TEXT NOT NULL,
  evidence_salt TEXT NOT NULL,
  evidence_commitment TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id),
  actor_wallet TEXT,
  status TEXT NOT NULL,               -- prepared | confirmed | offchain
  tx_hash TEXT UNIQUE,
  block_number INTEGER,
  chain_timestamp INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_milestones_case ON milestones(case_id);
CREATE INDEX IF NOT EXISTS idx_applications_case ON applications(case_id);
CREATE INDEX IF NOT EXISTS idx_orders_case ON orders(case_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_case ON screening_snapshots(case_id);
`;

export function openDb(file: string): DB {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export const nowIso = () => new Date().toISOString();
