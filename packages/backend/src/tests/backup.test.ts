import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { setDestructiveDbOpsEnabled, setSnapshotSanitizer } from "../routes/export";
import { updateSettings } from "../services/settings.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-backup.db";
let app: Hono;
let adminToken: string;

async function login(username: string, password: string): Promise<string> {
  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json()) as { data: { token: string } };
  return body.data.token;
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "backuptestpass";
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
  adminToken = await login("admin", "backuptestpass");

  // Add a customer so we can verify the backup contains real data
  getDb().run(
    "INSERT INTO customers (id, name, email) VALUES ('test-customer-1', 'Test Customer', 'test@example.com')",
  );
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

describe("GET /export/sqlite", () => {
  test("streams a parseable SQLite snapshot", async () => {
    const res = await app.request("/api/v1/export/sqlite", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (res.status !== 200) {
      const errBody = await res.text();
      throw new Error(`Expected 200, got ${res.status}: ${errBody}`);
    }
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");

    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);

    // Verify it's a real SQLite file by opening it
    const tmpPath = join(tmpdir(), `test-snapshot-${Date.now()}.db`);
    await Bun.write(tmpPath, buf);
    const probe = new Database(tmpPath, { readonly: true });
    try {
      const row = probe.query("SELECT name FROM customers WHERE id = ?").get("test-customer-1") as {
        name: string;
      } | null;
      expect(row?.name).toBe("Test Customer");
    } finally {
      probe.close();
      try {
        unlinkSync(tmpPath);
      } catch {}
    }
  });

  test("requires admin auth", async () => {
    const res = await app.request("/api/v1/export/sqlite");
    expect(res.status).toBe(401);
  });
});

describe("GET /export/backup", () => {
  test("leaves internal settings such as the vote secret out of the JSON", async () => {
    updateSettings({
      plugin_vote_secret: "vote-secret-must-stay-on-server",
      plugin_catalog_cache: '{"plugins":[]}',
    });

    const res = await app.request("/api/v1/export/backup", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("vote-secret-must-stay-on-server");

    const body = JSON.parse(text) as { data: { settings: Record<string, string> } };
    expect(body.data.settings.plugin_catalog_cache).toBeUndefined();
    expect(body.data.settings.company_name).toBeDefined();
  });
});

describe("GET /export/sqlite with a snapshot sanitizer", () => {
  afterEach(() => setSnapshotSanitizer(null));

  test("scrubs the copy it sends and leaves the live database alone", async () => {
    // Long enough to spill onto several overflow pages, which SQLite frees
    // without zeroing, so a careless scrub would leave the marker in the file.
    // settings has no search-index triggers that would reuse the freed pages.
    const secret = `${"a".repeat(20000)}scrub-target-marker${"b".repeat(200)}`;
    updateSettings({ scrub_probe: secret, scrub_keep: "kept" });
    const admin = getDb().query("SELECT id FROM users WHERE username = 'admin'").get() as {
      id: string;
    };
    let sanitizedFor: string | null | undefined;
    setSnapshotSanitizer((snapshot, ctx) => {
      sanitizedFor = ctx.userId;
      snapshot.run("DELETE FROM settings WHERE key = 'scrub_probe'");
    });

    const res = await app.request("/api/v1/export/sqlite", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());

    // Not even in freed page space: a hex editor must not recover it.
    expect(Buffer.from(buf).includes("scrub-target-marker")).toBe(false);
    expect(sanitizedFor).toBe(admin.id);

    const tmpPath = join(tmpdir(), `test-scrubbed-${Date.now()}.db`);
    await Bun.write(tmpPath, buf);
    const probe = new Database(tmpPath, { readonly: true });
    try {
      const rows = probe
        .query("SELECT key, value FROM settings WHERE key LIKE 'scrub_%' ORDER BY key")
        .all();
      expect(rows).toEqual([{ key: "scrub_keep", value: "kept" }]);
    } finally {
      probe.close();
      unlinkSync(tmpPath);
    }

    const live = getDb().query("SELECT value FROM settings WHERE key = 'scrub_probe'").get() as {
      value: string;
    };
    expect(live.value).toBe(secret);
  });

  test("a failing sanitizer fails the download instead of sending an unscrubbed copy", async () => {
    setSnapshotSanitizer(() => {
      throw new Error("scrub failed");
    });

    const res = await app.request("/api/v1/export/sqlite", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(500);
    const head = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()).slice(0, 15));
    expect(head).not.toBe("SQLite format 3");
  });
});

describe("POST /export/restore", () => {
  test("rejects non-SQLite files", async () => {
    const formData = new FormData();
    formData.append("backup", new Blob(["this is not sqlite"]), "fake.db");

    const res = await app.request("/api/v1/export/restore", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: formData,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("SQLite");
  });

  test("rejects empty uploads", async () => {
    const formData = new FormData();
    const res = await app.request("/api/v1/export/restore", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: formData,
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /export/wipe", () => {
  test("requires DELETE confirmation", async () => {
    const res = await app.request("/api/v1/export/wipe", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  test("wipes data and preserves admin user", async () => {
    // Add some throwaway data first
    const db = getDb();
    db.run("INSERT INTO customers (id, name) VALUES ('to-wipe', 'Wipe Me')");
    db.run("INSERT INTO products (id, name, unit_price) VALUES ('p-wipe', 'Test Product', 10)");

    const before = db.query("SELECT COUNT(*) as c FROM customers").get() as { c: number };
    expect(before.c).toBeGreaterThan(0);

    const res = await app.request("/api/v1/export/wipe", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(res.status).toBe(200);

    const customersAfter = db.query("SELECT COUNT(*) as c FROM customers").get() as { c: number };
    const productsAfter = db.query("SELECT COUNT(*) as c FROM products").get() as { c: number };
    const usersAfter = db.query("SELECT COUNT(*) as c FROM users WHERE is_admin = 1").get() as {
      c: number;
    };

    expect(customersAfter.c).toBe(0);
    expect(productsAfter.c).toBe(0);
    expect(usersAfter.c).toBeGreaterThan(0);
  });

  test("requires admin auth", async () => {
    const res = await app.request("/api/v1/export/wipe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("settings report whether restore and wipe are available", () => {
  afterEach(() => setDestructiveDbOpsEnabled(true));

  async function getSettings(): Promise<Record<string, string>> {
    const res = await app.request("/api/v1/settings", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Record<string, string> }).data;
  }

  test("a self-hosted install offers them", async () => {
    expect((await getSettings()).destructive_db_ops).toBe("true");
  });

  test("a deployment that disables them says so", async () => {
    setDestructiveDbOpsEnabled(false);
    expect((await getSettings()).destructive_db_ops).toBe("false");
  });

  test("saving settings keeps the answer, since the page replaces its state with the response", async () => {
    setDestructiveDbOpsEnabled(false);
    const res = await app.request("/api/v1/settings", {
      method: "PUT",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(await getSettings()),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, string> };
    expect(body.data.destructive_db_ops).toBe("false");
  });
});
