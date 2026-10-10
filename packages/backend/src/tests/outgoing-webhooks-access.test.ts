// Outgoing webhooks decide where invoice events (and the data in them) are
// sent, and a Slack webhook URL is itself a credential, so managing them is
// an admin task like the rest of Settings.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { resetEnvCache } from "../utils/env";
import { signToken } from "../utils/jwt";

const TEST_DB = "./data/test-outgoing-webhooks-access.db";
let app: Hono;
let adminToken = "";
let viewerToken = "";

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "webhookaccesspass";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
  initDatabase();
  runMigrations();
  await seed();
  app = createApp();

  const db = getDb();
  const admin = db.query("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
  db.run(
    "INSERT INTO users (id, username, email, password_hash, is_admin, is_active, role) VALUES ('viewer-1', 'viewer', 'viewer@example.com', 'x', 0, 1, 'Viewer')",
  );
  db.run(
    "INSERT INTO outgoing_webhooks (id, name, url, events, preset, is_active) VALUES ('hook-1', 'Slack', 'https://hooks.slack.com/services/T000/B000/slack-url-secret', '[\"invoice.paid\"]', 'slack', 1)",
  );
  adminToken = await signToken({ sub: admin.id, username: "admin", is_admin: true });
  viewerToken = await signToken({ sub: "viewer-1", username: "viewer", is_admin: false });
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

function call(token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("outgoing webhooks access", () => {
  test("members who are not admins can neither read nor add them", async () => {
    const list = await call(viewerToken, "GET", "/api/v1/outgoing-webhooks");
    expect(list.status).toBe(403);
    expect(await list.text()).not.toContain("slack-url-secret");

    const add = await call(viewerToken, "POST", "/api/v1/outgoing-webhooks", {
      name: "Exfiltrate",
      url: "https://collector.example/hook",
      events: ["invoice.paid"],
    });
    expect(add.status).toBe(403);
    const count = getDb().query("SELECT COUNT(*) AS n FROM outgoing_webhooks").get();
    expect(count).toEqual({ n: 1 });
  });

  test("admins manage them as before", async () => {
    const list = await call(adminToken, "GET", "/api/v1/outgoing-webhooks");
    expect(list.status).toBe(200);
    expect(await list.text()).toContain("hook-1");
  });
});
