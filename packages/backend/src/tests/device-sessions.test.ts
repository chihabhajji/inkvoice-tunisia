import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { createToken, hashToken } from "../services/api-token.service";
import {
  DEVICE_TOKEN_PREFIX,
  generateDeviceToken,
  touchDeviceSession,
} from "../services/device-session.service";
import { createUser } from "../services/user.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-device-sessions.db";
const ADMIN_PASS = "devicesessiontestpass";
const MEMBER_PASS = "member-password-123";
let app: Hono;
let adminId: string;
let memberId: string;

const DEVICE = {
  name: "Test iPhone",
  platform: "ios",
  model: "iPhone 17",
  os_version: "27.0",
  app_version: "1.0.0",
};

function request(path: string, opts: { method?: string; bearer?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(`http://localhost${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function signIn(
  username = "admin",
  password = ADMIN_PASS,
  device: Record<string, unknown> = DEVICE,
) {
  const res = await request("/api/v1/auth/device-sessions", {
    method: "POST",
    body: { username, password, device },
  });
  return { res, body: (await res.json()) as any };
}

async function newSession(username = "admin", password = ADMIN_PASS) {
  const { res, body } = await signIn(username, password);
  expect(res.status).toBe(201);
  return body.data as { token: string; session: { id: string } };
}

function sessionRow(id: string) {
  return getDb().query("SELECT * FROM device_sessions WHERE id = ?").get(id) as Record<
    string,
    string | null
  >;
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = ADMIN_PASS;
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {}
  }

  initDatabase();
  runMigrations();
  await seed();
  app = createApp();

  adminId = (getDb().query("SELECT id FROM users WHERE username = 'admin'").get() as { id: string })
    .id;
  const member = (await createUser({
    username: "member",
    password: MEMBER_PASS,
    role: "Viewer",
  } as Parameters<typeof createUser>[0])) as unknown as { id: string };
  memberId = member.id;
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {}
  }
});

describe("device token", () => {
  test("is ink_dev_ plus base64url of 32 bytes", () => {
    const { token, prefix } = generateDeviceToken();
    expect(token.startsWith(DEVICE_TOKEN_PREFIX)).toBe(true);
    const random = token.slice(DEVICE_TOKEN_PREFIX.length);
    expect(random).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(random, "base64url").length).toBe(32);
    expect(prefix).toBe(token.slice(0, 16));
    expect(generateDeviceToken().token).not.toBe(token);
  });

  test("only the hash and a short prefix are stored", async () => {
    const { token, session } = await newSession();
    const row = sessionRow(session.id);
    expect(row.token_hash).toBe(hashToken(token));
    expect(row.token_prefix).toBe(token.slice(0, 16));
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(token);
  });
});

describe("POST /api/v1/auth/device-sessions", () => {
  test("signs in and returns token, session and the /auth/me user shape", async () => {
    const { res, body } = await signIn();
    expect(res.status).toBe(201);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(body.success).toBe(true);
    expect(body.data.token.startsWith(DEVICE_TOKEN_PREFIX)).toBe(true);
    expect(Object.keys(body.data.session).sort()).toEqual(
      [
        "id",
        "name",
        "platform",
        "model",
        "os_version",
        "app_version",
        "created_at",
        "last_seen_at",
        "expires_at",
      ].sort(),
    );
    expect(body.data.session.name).toBe("Test iPhone");
    expect(body.data.session.platform).toBe("ios");

    // Idle expiry defaults to 90 days.
    const days = (new Date(body.data.session.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThanOrEqual(90);

    const me = (await (
      await request("/api/v1/auth/me", { bearer: body.data.token })
    ).json()) as any;
    const { impersonation: _ignored, ...meUser } = me.data;
    expect(body.data.user).toEqual(meUser);
    expect(Object.keys(body.data.user).sort()).toEqual(
      [
        "id",
        "username",
        "email",
        "display_name",
        "is_admin",
        "role",
        "permissions",
        "access",
      ].sort(),
    );
  });

  test("logs a login activity entry", async () => {
    await newSession();
    const row = getDb()
      .query(
        "SELECT metadata FROM activity_log WHERE action = 'login' AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(adminId) as { metadata: string };
    expect(JSON.parse(row.metadata).method).toBe("device_session");
  });

  test("wrong password and unknown user fail identically", async () => {
    const wrong = await signIn("admin", "not-the-password");
    const unknown = await signIn("nobody-here", "whatever-password");
    for (const r of [wrong, unknown]) {
      expect(r.res.status).toBe(401);
      expect(r.body).toEqual({
        success: false,
        error: "Invalid credentials",
        code: "INVALID_CREDENTIALS",
      });
    }
  });

  test("validates the device", async () => {
    const missingName = await signIn("admin", ADMIN_PASS, { platform: "ios" });
    expect(missingName.res.status).toBe(400);
    expect(missingName.body.success).toBe(false);

    const badPlatform = await signIn("admin", ADMIN_PASS, { name: "x", platform: "windows" });
    expect(badPlatform.res.status).toBe(400);

    const longName = await signIn("admin", ADMIN_PASS, { name: "x".repeat(101), platform: "ios" });
    expect(longName.res.status).toBe(400);
  });
});

describe("auth middleware with a device token", () => {
  test("authenticates a protected route", async () => {
    const { token } = await newSession();
    const res = await request("/api/v1/customers", { bearer: token });
    expect(res.status).toBe(200);
  });

  test("is not restricted by the API-token scope middleware", async () => {
    const { token } = await newSession();
    // A scoped API token is refused here (dashboard is outside the scope
    // vocabulary); a device session acts as the user.
    const scoped = createToken(adminId, "scoped", ["invoices:read"]).token;
    expect((await request("/api/v1/dashboard/stats", { bearer: scoped })).status).toBe(403);
    expect((await request("/api/v1/dashboard/stats", { bearer: token })).status).toBe(200);
  });

  test("reads is_admin fresh, so a demotion applies on the next request", async () => {
    getDb().run("UPDATE users SET is_admin = 1 WHERE id = ?", [memberId]);
    const { token } = await newSession("member", MEMBER_PASS);
    expect((await request("/api/v1/users", { bearer: token })).status).toBe(200);
    getDb().run("UPDATE users SET is_admin = 0 WHERE id = ?", [memberId]);
    expect((await request("/api/v1/users", { bearer: token })).status).toBe(403);
  });

  test("rejects an unknown, revoked or expired token with 401", async () => {
    expect(
      (await request("/api/v1/customers", { bearer: generateDeviceToken().token })).status,
    ).toBe(401);

    const revoked = await newSession();
    getDb().run("UPDATE device_sessions SET revoked_at = ? WHERE id = ?", [
      new Date().toISOString(),
      revoked.session.id,
    ]);
    expect((await request("/api/v1/customers", { bearer: revoked.token })).status).toBe(401);

    const expired = await newSession();
    getDb().run("UPDATE device_sessions SET expires_at = ? WHERE id = ?", [
      new Date(Date.now() - 1000).toISOString(),
      expired.session.id,
    ]);
    expect((await request("/api/v1/customers", { bearer: expired.token })).status).toBe(401);
  });

  test("rejects a deactivated user", async () => {
    const user = (await createUser({
      username: "leaver",
      password: "leaver-password-123",
    } as Parameters<typeof createUser>[0])) as unknown as { id: string };
    const { token } = await newSession("leaver", "leaver-password-123");
    getDb().run("UPDATE users SET is_active = 0 WHERE id = ?", [user.id]);
    expect((await request("/api/v1/customers", { bearer: token })).status).toBe(401);
  });

  test("updates last_seen_at and slides expires_at at most every 5 minutes", async () => {
    const { token, session } = await newSession();
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const nearExpiry = new Date(Date.now() + 86_400_000).toISOString();
    getDb().run("UPDATE device_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?", [
      tenMinutesAgo,
      nearExpiry,
      session.id,
    ]);

    await request("/api/v1/customers", { bearer: token });
    const touched = sessionRow(session.id);
    expect(touched.last_seen_at).not.toBe(tenMinutesAgo);
    expect(new Date(touched.expires_at as string).getTime()).toBeGreaterThan(
      Date.now() + 89 * 86_400_000,
    );

    // A second request right away doesn't write again.
    getDb().run("UPDATE device_sessions SET expires_at = ? WHERE id = ?", [nearExpiry, session.id]);
    await request("/api/v1/customers", { bearer: token });
    const untouched = sessionRow(session.id);
    expect(untouched.last_seen_at).toBe(touched.last_seen_at);
    expect(untouched.expires_at).toBe(nearExpiry);
  });

  test("touchDeviceSession reports whether it wrote", () => {
    const recent = { id: "nope", last_seen_at: new Date().toISOString() };
    expect(touchDeviceSession(recent, null)).toBe(false);
    const stale = { id: "nope", last_seen_at: new Date(Date.now() - 6 * 60 * 1000).toISOString() };
    expect(touchDeviceSession(stale, null)).toBe(true);
  });
});

describe("listing and revoking", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM device_sessions");
  });

  test("lists my live sessions, newest last_seen first, flagging the current one", async () => {
    const a = await newSession();
    const b = await newSession();
    const other = await newSession("member", MEMBER_PASS);
    getDb().run("UPDATE device_sessions SET last_seen_at = ? WHERE id = ?", [
      new Date(Date.now() - 60_000).toISOString(),
      a.session.id,
    ]);
    const revoked = await newSession();
    getDb().run("UPDATE device_sessions SET revoked_at = ? WHERE id = ?", [
      new Date().toISOString(),
      revoked.session.id,
    ]);

    const body = (await (
      await request("/api/v1/auth/device-sessions", { bearer: a.token })
    ).json()) as any;
    expect(body.success).toBe(true);
    const ids = body.data.map((s: { id: string }) => s.id);
    expect(ids).toEqual([b.session.id, a.session.id]);
    expect(ids).not.toContain(other.session.id);
    expect(body.data.find((s: any) => s.id === a.session.id).current).toBe(true);
    expect(body.data.find((s: any) => s.id === b.session.id).current).toBe(false);
    expect(body.data[0].token_hash).toBeUndefined();
  });

  test("listing requires auth", async () => {
    expect((await request("/api/v1/auth/device-sessions")).status).toBe(401);
  });

  test("DELETE /current revokes the calling session", async () => {
    const { token, session } = await newSession();
    const res = await request("/api/v1/auth/device-sessions/current", {
      method: "DELETE",
      bearer: token,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(sessionRow(session.id).revoked_reason).toBe("signed_out");
    expect((await request("/api/v1/customers", { bearer: token })).status).toBe(401);
  });

  test("DELETE /current is a 400 for a non-device session", async () => {
    const login = (await (
      await request("/api/v1/auth/login", {
        method: "POST",
        body: { username: "admin", password: ADMIN_PASS },
      })
    ).json()) as any;
    const res = await request("/api/v1/auth/device-sessions/current", {
      method: "DELETE",
      bearer: login.data.token,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).success).toBe(false);
  });

  test("DELETE /:id revokes my own session and 404s on someone else's", async () => {
    const mine = await newSession();
    const victim = await newSession();
    const res = await request(`/api/v1/auth/device-sessions/${victim.session.id}`, {
      method: "DELETE",
      bearer: mine.token,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect((await request("/api/v1/customers", { bearer: victim.token })).status).toBe(401);

    const theirs = await newSession("member", MEMBER_PASS);
    const denied = await request(`/api/v1/auth/device-sessions/${theirs.session.id}`, {
      method: "DELETE",
      bearer: mine.token,
    });
    expect(denied.status).toBe(404);
    expect((await request("/api/v1/customers", { bearer: theirs.token })).status).toBe(200);
  });

  test("an admin can revoke every session of a user", async () => {
    const admin = await newSession();
    const m1 = await newSession("member", MEMBER_PASS);
    const m2 = await newSession("member", MEMBER_PASS);

    // Not for non-admins.
    const forbidden = await request(`/api/v1/users/${adminId}/device-sessions`, {
      method: "DELETE",
      bearer: m1.token,
    });
    expect(forbidden.status).toBe(403);

    const res = await request(`/api/v1/users/${memberId}/device-sessions`, {
      method: "DELETE",
      bearer: admin.token,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    for (const s of [m1, m2]) {
      expect((await request("/api/v1/customers", { bearer: s.token })).status).toBe(401);
      expect(sessionRow(s.session.id).revoked_reason).toBe("revoked_by_admin");
    }
    expect((await request("/api/v1/customers", { bearer: admin.token })).status).toBe(200);

    const missing = await request("/api/v1/users/does-not-exist/device-sessions", {
      method: "DELETE",
      bearer: admin.token,
    });
    expect(missing.status).toBe(404);
  });

  test("a password reset revokes every device session of that user", async () => {
    const s = await newSession("member", MEMBER_PASS);
    const resetToken = "r".repeat(64);
    getDb().run("INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)", [
      resetToken,
      memberId,
      new Date(Date.now() + 3_600_000).toISOString(),
    ]);
    const res = await request("/api/v1/auth/reset-password", {
      method: "POST",
      body: { token: resetToken, password: "a-brand-new-password" },
    });
    expect(res.status).toBe(200);
    expect(sessionRow(s.session.id).revoked_reason).toBe("password_reset");
    expect((await request("/api/v1/customers", { bearer: s.token })).status).toBe(401);
  });
});
