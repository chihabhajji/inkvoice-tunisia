import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { setPublicConfigExtender } from "../routes/public";
import { getEnv, resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-public-config.db";
let app: Hono;

/** Re-read the env with DEMO_MODE / admin credentials set as given. */
function setEnv(vars: { demo?: string; user?: string; pass?: string }): void {
  if (vars.demo === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = vars.demo;
  if (vars.user === undefined) delete process.env.ADMIN_USER;
  else process.env.ADMIN_USER = vars.user;
  if (vars.pass === undefined) delete process.env.ADMIN_PASS;
  else process.env.ADMIN_PASS = vars.pass;
  resetEnvCache();
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  setEnv({ user: "admin", pass: "publicconfigtestpass" });
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
  initDatabase();
  runMigrations();
  await seed();
  app = createApp();
});

afterAll(() => {
  setEnv({});
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

async function getConfig(): Promise<{
  demo_mode: boolean;
  demo_credentials: { username: string; password: string } | null;
}> {
  // No Authorization header: this must answer before auth.
  const res = await app.request("/api/v1/public/config");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    success: boolean;
    data: {
      demo_mode: boolean;
      demo_credentials: { username: string; password: string } | null;
    };
  };
  expect(body.success).toBe(true);
  return body.data;
}

describe("GET /api/v1/public/config", () => {
  test("reports no demo mode and no credentials on a normal install", async () => {
    setEnv({ user: "admin", pass: "publicconfigtestpass" });
    const data = await getConfig();
    expect(data.demo_mode).toBe(false);
    expect(data.demo_credentials).toBeNull();
  });

  test("publishes the demo credentials when DEMO_MODE is on", async () => {
    setEnv({ demo: "true" });
    const data = await getConfig();
    expect(data.demo_mode).toBe(true);
    expect(data.demo_credentials).toEqual({ username: "demo", password: "demo" });
  });

  test("DEMO_MODE defaults the admin account to demo/demo", () => {
    setEnv({ demo: "true" });
    const env = getEnv();
    expect(env.ADMIN_USER).toBe("demo");
    expect(env.ADMIN_PASS).toBe("demo");
  });

  test("an explicit ADMIN_PASS still wins in demo mode", () => {
    setEnv({ demo: "true", pass: "changeme" });
    expect(getEnv().ADMIN_PASS).toBe("changeme");
  });

  test("without DEMO_MODE the admin account still defaults to admin/changeme", () => {
    setEnv({});
    const env = getEnv();
    expect(env.ADMIN_USER).toBe("admin");
    expect(env.ADMIN_PASS).toBe("changeme");
  });

  test("never publishes a real password when DEMO_MODE is on with custom credentials", async () => {
    setEnv({ demo: "true", user: "owner", pass: "a-real-production-password" });
    const data = await getConfig();
    // Demo mode is still reported (it drives the "data resets" banner), but the
    // operator's own credentials are not disclosed.
    expect(data.demo_mode).toBe(true);
    expect(data.demo_credentials).toBeNull();
  });

  test("withholds the credentials when only the demo password is customised", async () => {
    setEnv({ demo: "true", user: "demo", pass: "not-demo" });
    const data = await getConfig();
    expect(data.demo_credentials).toBeNull();
  });

  test("does not publish the demo pair when DEMO_MODE is off", async () => {
    setEnv({ user: "demo", pass: "demo" });
    const data = await getConfig();
    expect(data.demo_mode).toBe(false);
    expect(data.demo_credentials).toBeNull();
  });

  test("publishes oidc_enabled=false when SSO is not configured", async () => {
    process.env.OIDC_ISSUER_URL = "";
    resetEnvCache();
    const res = await app.request("/api/v1/public/config");
    const data = (await res.json()) as any;
    expect(data.data.oidc_enabled).toBe(false);
    expect(data.data.oidc_provider_name).toBeNull();
  });

  test("publishes oidc_enabled=true and the provider name when configured", async () => {
    process.env.OIDC_ISSUER_URL = "https://auth.example.com";
    process.env.OIDC_CLIENT_ID = "inkvoice";
    process.env.OIDC_CLIENT_SECRET = "secret";
    process.env.OIDC_PROVIDER_NAME = "Google Workspace";
    resetEnvCache();
    const res = await app.request("/api/v1/public/config");
    const data = (await res.json()) as any;
    expect(data.data.oidc_enabled).toBe(true);
    expect(data.data.oidc_provider_name).toBe("Google Workspace");
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    delete process.env.OIDC_PROVIDER_NAME;
    resetEnvCache();
  });
});

describe("GET /api/v1/public/config server info", () => {
  async function getRaw(): Promise<Record<string, any>> {
    const res = await app.request("/api/v1/public/config");
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Record<string, any> }).data;
  }

  test("reports server, auth, features and mobile fields", async () => {
    setEnv({ user: "admin", pass: "publicconfigtestpass" });
    const data = await getRaw();
    const { version } = await import("../../package.json");
    expect(data.server).toEqual({ version, api_level: 1 });
    expect(data.auth).toEqual({
      password: true,
      device_sessions: true,
      oidc: { enabled: false, label: null, mobile: false },
      oauth: [],
    });
    expect(data.features).toEqual({ push: false, attachments: false, idempotency: false });
    expect(data.mobile).toEqual({ min_app_version: null });
    // The fields the web login page already reads are still there.
    expect(data.oidc_enabled).toBe(false);
    expect(data.oidc_provider_name).toBeNull();
    expect(data.demo_mode).toBe(false);
  });

  test("a registered extender can merge extra fields", async () => {
    setPublicConfigExtender((data) => ({
      ...data,
      auth: { ...(data.auth as object), oauth: [{ id: "google", label: "Google" }] },
      workspace: { name: "Acme" },
    }));
    try {
      const data = await getRaw();
      expect(data.auth.oauth).toEqual([{ id: "google", label: "Google" }]);
      expect(data.auth.device_sessions).toBe(true);
      expect(data.workspace).toEqual({ name: "Acme" });
    } finally {
      setPublicConfigExtender(null);
    }
    expect((await getRaw()).workspace).toBeUndefined();
  });
});
