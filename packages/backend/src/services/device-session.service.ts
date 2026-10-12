import crypto from "node:crypto";
import { getDb } from "../database/connection";
import { getEnv } from "../utils/env";
import { hashToken } from "./api-token.service";

// Device sessions are how the mobile app stays signed in. The bearer token is
// an opaque `ink_dev_` string with full entropy, so (like API tokens) a plain
// SHA-256 digest is stored and looked up on every request. Expiry slides
// forward on use; revocation is immediate because nothing is cached.

export const DEVICE_TOKEN_PREFIX = "ink_dev_";

/** last_seen_at / expires_at are written at most this often per session. */
export const DEVICE_SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export type DevicePlatform = "ios" | "android";

export interface DeviceInfo {
  name: string;
  platform: DevicePlatform;
  model?: string | null;
  os_version?: string | null;
  app_version?: string | null;
}

export interface DeviceSessionRecord {
  id: string;
  name: string;
  platform: DevicePlatform;
  model: string | null;
  os_version: string | null;
  app_version: string | null;
  created_at: string;
  last_seen_at: string | null;
  expires_at: string;
}

interface DeviceSessionRow extends DeviceSessionRecord {
  user_id: string;
  token_hash: string;
  token_prefix: string;
  last_seen_ip: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export function generateDeviceToken(): { token: string; prefix: string } {
  const token = `${DEVICE_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  // "ink_dev_" plus 8 random characters identifies the session in logs and UI.
  return { token, prefix: token.slice(0, 16) };
}

function idleExpiry(from: number): string {
  return new Date(from + getEnv().DEVICE_SESSION_IDLE_DAYS * 86_400_000).toISOString();
}

function toRecord(row: DeviceSessionRow): DeviceSessionRecord {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    model: row.model,
    os_version: row.os_version,
    app_version: row.app_version,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    expires_at: row.expires_at,
  };
}

export function createDeviceSession(
  userId: string,
  device: DeviceInfo,
  ip: string | null,
): { token: string; session: DeviceSessionRecord } {
  const db = getDb();
  const { token, prefix } = generateDeviceToken();
  const id = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  db.run(
    `INSERT INTO device_sessions
       (id, user_id, token_hash, token_prefix, name, platform, model, os_version, app_version,
        created_at, last_seen_at, last_seen_ip, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      userId,
      hashToken(token),
      prefix,
      device.name,
      device.platform,
      device.model ?? null,
      device.os_version ?? null,
      device.app_version ?? null,
      nowIso,
      nowIso,
      ip,
      idleExpiry(now),
    ],
  );
  const row = db.query("SELECT * FROM device_sessions WHERE id = ?").get(id) as DeviceSessionRow;
  return { token, session: toRecord(row) };
}

/** Resolve a presented token to its live session (not revoked, not expired). */
export function findActiveDeviceSession(
  token: string,
): { id: string; user_id: string; last_seen_at: string | null } | null {
  const row = getDb()
    .query(
      "SELECT id, user_id, last_seen_at, expires_at FROM device_sessions WHERE token_hash = ? AND revoked_at IS NULL",
    )
    .get(hashToken(token)) as {
    id: string;
    user_id: string;
    last_seen_at: string | null;
    expires_at: string;
  } | null;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return { id: row.id, user_id: row.user_id, last_seen_at: row.last_seen_at };
}

/**
 * Record use and slide the expiry, but only when the last write is older than
 * the touch interval, so ordinary reads don't each become a write.
 */
export function touchDeviceSession(
  session: { id: string; last_seen_at: string | null },
  ip: string | null,
): boolean {
  const now = Date.now();
  if (
    session.last_seen_at &&
    now - new Date(session.last_seen_at).getTime() < DEVICE_SESSION_TOUCH_INTERVAL_MS
  ) {
    return false;
  }
  getDb().run(
    "UPDATE device_sessions SET last_seen_at = ?, last_seen_ip = ?, expires_at = ? WHERE id = ?",
    [new Date(now).toISOString(), ip, idleExpiry(now), session.id],
  );
  return true;
}

export function listDeviceSessions(userId: string): DeviceSessionRecord[] {
  const rows = getDb()
    .query(
      `SELECT * FROM device_sessions
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY last_seen_at DESC, created_at DESC`,
    )
    .all(userId, new Date().toISOString()) as DeviceSessionRow[];
  return rows.map(toRecord);
}

/** Revoke one of the user's own sessions. False when it isn't theirs or is already gone. */
export function revokeDeviceSession(id: string, userId: string, reason: string): boolean {
  const res = getDb().run(
    `UPDATE device_sessions SET revoked_at = ?, revoked_reason = ?
     WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    [new Date().toISOString(), reason, id, userId],
  );
  return res.changes > 0;
}

/** Revoke every live session a user has. Returns how many were revoked. */
export function revokeAllDeviceSessions(userId: string, reason: string): number {
  const res = getDb().run(
    `UPDATE device_sessions SET revoked_at = ?, revoked_reason = ?
     WHERE user_id = ? AND revoked_at IS NULL`,
    [new Date().toISOString(), reason, userId],
  );
  return res.changes;
}
