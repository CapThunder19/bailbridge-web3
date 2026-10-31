import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { DB } from "./db.js";

export type Role = "caseworker" | "lawyer" | "issuer" | "prison";

export interface User {
  id: number;
  username: string;
  role: Role;
  displayName: string;
  walletAddress: string | null;
}

export const SESSION_COOKIE = "bb_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

interface UserRow {
  id: number;
  username: string;
  role: Role;
  display_name: string;
  wallet_address: string | null;
  password_hash: string;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  username: r.username,
  role: r.role,
  displayName: r.display_name,
  walletAddress: r.wallet_address,
});

export function authenticate(db: DB, username: string, password: string): User | null {
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
  // Always run scrypt so timing does not reveal whether the username exists.
  const ok = verifyPassword(password, row?.password_hash ?? hashPassword("x"));
  return row && ok ? toUser(row) : null;
}

export function createSession(db: DB, userId: number): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
    tokenHash(token),
    userId,
    expiresAt,
  );
  return { token, expiresAt };
}

export function destroySession(db: DB, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
}

export function userForSession(db: DB, token: string | undefined): User | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(tokenHash(token), Date.now()) as UserRow | undefined;
  return row ? toUser(row) : null;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: User;
  }
}

/** Attach req.user from the session cookie (does not reject). */
export function sessionMiddleware(db: DB) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = userForSession(db, req.cookies?.[SESSION_COOKIE]);
    if (user) req.user = user;
    next();
  };
}

/** Require a logged-in user, optionally with one of the given roles. */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Please sign in." });
    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: `This action requires the ${roles.join(" or ")} role.` });
    }
    next();
  };
}

export interface DemoUserSpec {
  username: string;
  role: Role;
  displayName: string;
  walletAddress: string | null;
}

export function demoUsers(wallets: { lawyer: string | null; issuer: string | null; prison: string | null }): DemoUserSpec[] {
  return [
    { username: "caseworker", role: "caseworker", displayName: "Demo NGO Caseworker", walletAddress: null },
    { username: "lawyer", role: "lawyer", displayName: "Demo Legal-Aid Lawyer", walletAddress: wallets.lawyer },
    { username: "issuer", role: "issuer", displayName: "Demo Court Issuer", walletAddress: wallets.issuer },
    { username: "prison", role: "prison", displayName: "Demo District Prison Superintendent", walletAddress: wallets.prison },
  ];
}

/** Create demo users if missing; keep their wallet mapping in sync with config. */
export function ensureDemoUsers(db: DB, specs: DemoUserSpec[], password: string): void {
  const find = db.prepare("SELECT id FROM users WHERE username = ?");
  const insert = db.prepare(
    "INSERT INTO users (username, password_hash, role, display_name, wallet_address) VALUES (?, ?, ?, ?, ?)",
  );
  const update = db.prepare("UPDATE users SET role = ?, display_name = ?, wallet_address = ? WHERE username = ?");
  for (const u of specs) {
    const wallet = u.walletAddress ? u.walletAddress.toLowerCase() : null;
    if (find.get(u.username)) update.run(u.role, u.displayName, wallet, u.username);
    else insert.run(u.username, hashPassword(password), u.role, u.displayName, wallet);
  }
}
