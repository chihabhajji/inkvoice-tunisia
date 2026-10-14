import type { Context, MiddlewareHandler, Next } from "hono";
import { getCookie } from "hono/cookie";
import { getDb } from "../database/connection";
import { findActiveTokenByHash, hashToken, touchLastUsed } from "../services/api-token.service";
import {
  DEVICE_TOKEN_PREFIX,
  findActiveDeviceSession,
  touchDeviceSession,
} from "../services/device-session.service";
import type { Action, Resource } from "../types/user";
import { CURRENT_JWT_VERSION, type JWTPayload, verifyToken } from "../utils/jwt";
import { roleAllows } from "../utils/permissions";
import { clientIp } from "./rate-limiter";

declare module "hono" {
  interface ContextVariableMap {
    user: JWTPayload;
    userId: string;
    /** Set when the request was authenticated with a public API token. */
    apiToken?: { id: string; scopes: string[] };
    /** Set when the request was authenticated with a mobile device session. */
    deviceSession?: { id: string };
    /** Set by a multi-tenant overlay's middleware. Undefined standalone. */
    tenant?: { id: string; slug: string; status: string; plan: string };
  }
}

// Public API tokens are opaque (non-JWT) and carry this prefix so the middleware
// can route them to the token-lookup path instead of JWT verification.
const API_TOKEN_PREFIX = "ink_";

export async function authMiddleware(c: Context, next: Next) {
  let token: string | undefined;

  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }

  // Mobile device sessions. Checked before the API-token branch because
  // `ink_dev_` also starts with `ink_`.
  if (token?.startsWith(DEVICE_TOKEN_PREFIX)) {
    return authenticateDeviceSession(c, next, token);
  }

  // Bearer tokens with the API-token prefix are long-lived integration tokens,
  // not session JWTs — authenticate them against the api_tokens table.
  if (token?.startsWith(API_TOKEN_PREFIX)) {
    return authenticateApiToken(c, next, token);
  }

  if (!token) {
    token = getCookie(c, "session") || undefined;
  }

  if (!token) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  let payload: JWTPayload;
  try {
    payload = await verifyToken(token);
  } catch {
    return c.json({ success: false, error: "Invalid or expired token" }, 401);
  }

  // Reject pre-versioning tokens — forces a one-time re-login on rollout.
  // Tokens missing `v` are pre-T1.4; current code always issues v=1+.
  if (typeof payload.v !== "number" || payload.v < CURRENT_JWT_VERSION) {
    return c.json({ success: false, error: "Token expired (please log in again)" }, 401);
  }

  // Cross-tenant binding: a token issued for tenant A must not be honored on
  // tenant B's subdomain. Only enforced when a tenant is on the request
  // context (multi-tenant overlay); standalone requests resolve no tenant.
  const tenant = c.get("tenant") as { id: string } | undefined;
  if (tenant) {
    if (!payload.tenant_id || payload.tenant_id !== tenant.id) {
      return c.json({ success: false, error: "Token does not match tenant" }, 401);
    }
  }

  // Verify user is still active in the resolved DB.
  const db = getDb();
  const activeUser = db
    .query("SELECT is_active FROM users WHERE id = ? AND is_active = 1")
    .get(payload.sub);
  if (!activeUser) {
    return c.json({ success: false, error: "Account deactivated" }, 401);
  }

  c.set("user", payload);
  c.set("userId", payload.sub);
  await next();
}

async function authenticateApiToken(c: Context, next: Next, token: string) {
  const tokenRow = findActiveTokenByHash(hashToken(token));
  if (!tokenRow) {
    return c.json({ success: false, error: "Invalid API token" }, 401);
  }

  const db = getDb();
  const user = db
    .query("SELECT id, username, is_admin FROM users WHERE id = ? AND is_active = 1")
    .get(tokenRow.user_id) as { id: string; username: string; is_admin: number } | null;
  if (!user) {
    return c.json({ success: false, error: "Account deactivated" }, 401);
  }

  // A token belongs to exactly one tenant's DB, so cross-tenant replay is
  // impossible by construction (the hash won't exist in another tenant's DB).
  const tenant = c.get("tenant") as { id: string } | undefined;
  const payload: JWTPayload = {
    sub: user.id,
    username: user.username,
    is_admin: !!user.is_admin,
    tenant_id: tenant?.id,
    v: CURRENT_JWT_VERSION,
    // API tokens don't expire on a clock; revocation is the kill switch.
    exp: Math.floor(Date.now() / 1000) + 31_536_000,
  };

  touchLastUsed(tokenRow.id);
  c.set("user", payload);
  c.set("userId", user.id);
  c.set("apiToken", { id: tokenRow.id, scopes: tokenRow.scopes });
  await next();
}

async function authenticateDeviceSession(c: Context, next: Next, token: string) {
  const session = findActiveDeviceSession(token);
  if (!session) {
    return c.json({ success: false, error: "Invalid or expired session" }, 401);
  }

  const db = getDb();
  const user = db
    .query("SELECT id, username, is_admin FROM users WHERE id = ? AND is_active = 1")
    .get(session.user_id) as { id: string; username: string; is_admin: number } | null;
  if (!user) {
    return c.json({ success: false, error: "Account deactivated" }, 401);
  }

  // Same tenancy model as API tokens: the session row lives in exactly one
  // tenant's DB, so a token presented on another tenant finds no row.
  const tenant = c.get("tenant") as { id: string } | undefined;
  const payload: JWTPayload = {
    sub: user.id,
    username: user.username,
    // Read fresh on every request, so a demotion applies immediately.
    is_admin: !!user.is_admin,
    tenant_id: tenant?.id,
    v: CURRENT_JWT_VERSION,
    // The session row's sliding expires_at is the real lifetime.
    exp: Math.floor(Date.now() / 1000) + 31_536_000,
  };

  const ip = clientIp(c);
  touchDeviceSession(session, ip === "unknown" ? null : ip);
  c.set("user", payload);
  c.set("userId", user.id);
  c.set("deviceSession", { id: session.id });
  await next();
}

/** Whether `user` may perform `action` on `resource`. For checks that depend
 *  on the request body; a route otherwise uses requirePermission. */
export function hasPermission(user: JWTPayload, resource: Resource, action: Action): boolean {
  // Admin / Owner short-circuit.
  if (user.is_admin) return true;

  const db = getDb();

  // Prefer role-based check (post-T2.11). Falls back to legacy
  // user_permissions row check for tenants/users that haven't migrated yet.
  const userRow = db.query("SELECT role FROM users WHERE id = ?").get(user.sub) as {
    role: string | null;
  } | null;

  if (userRow?.role && roleAllows(userRow.role, resource, action)) return true;

  const perm = db
    .query("SELECT id FROM user_permissions WHERE user_id = ? AND resource = ? AND action = ?")
    .get(user.sub, resource, action);
  return !!perm;
}

// Typed as MiddlewareHandler so a route's own handler keeps its typed params.
export function requirePermission(resource: Resource, action: Action): MiddlewareHandler {
  return async (c, next) => {
    if (!hasPermission(c.get("user"), resource, action)) {
      return c.json({ success: false, error: "Forbidden" }, 403);
    }
    await next();
  };
}
