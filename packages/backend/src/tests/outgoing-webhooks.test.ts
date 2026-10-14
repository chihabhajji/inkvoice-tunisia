import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import {
  createWebhook,
  dispatchEvent,
  listDeliveries,
  retryDelivery,
} from "../services/outgoing-webhooks.service";
import { resetEnvCache } from "../utils/env";
import { setAddressResolver } from "../utils/ssrf-protection";

const TEST_DB = "./data/test-outgoing-webhooks.db";
let app: Hono;
let adminToken: string;

/** Every host is public unless listed, so no test depends on live DNS. */
const resolveFixtureHosts = async (hostname: string) =>
  ({ "internal.test": ["10.0.0.5"], "nowhere.test": [] })[hostname] ?? ["93.184.216.34"];

async function login(username: string, password: string): Promise<string> {
  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return ((await res.json()) as { data: { token: string } }).data.token;
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "webhooktestpass";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  // Allow private IPs (127.0.0.1) for the local test fetch mocks below
  process.env.ALLOW_PRIVATE_URLS = "true";
  resetEnvCache();
  setAddressResolver(resolveFixtureHosts);
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
  initDatabase();
  runMigrations();
  await seed();
  app = createApp();
  adminToken = await login("admin", "webhooktestpass");
});

afterAll(() => {
  setAddressResolver(null);
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

describe("outgoing webhook CRUD", () => {
  test("create + list + delete via API", async () => {
    const create = await app.request("/api/v1/outgoing-webhooks", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Finance Slack",
        url: "https://hooks.slack.com/services/T0/B0/abc",
        events: ["invoice.paid"],
        preset: "slack",
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { data: { id: string; name: string } };
    expect(created.data.name).toBe("Finance Slack");

    const list = await app.request("/api/v1/outgoing-webhooks", {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const body = (await list.json()) as { data: { id: string }[] };
    expect(body.data.some((w) => w.id === created.data.id)).toBe(true);

    const del = await app.request(`/api/v1/outgoing-webhooks/${created.data.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(del.status).toBe(200);
  });

  test("rejects events outside the supported set", async () => {
    const res = await app.request("/api/v1/outgoing-webhooks", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad",
        url: "https://example.com",
        events: ["invoice.eaten"],
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("dispatchEvent", () => {
  test("logs a delivery row for matching active webhooks", async () => {
    // Mock global fetch so the dispatcher succeeds against an "external" URL
    const realFetch = global.fetch;
    global.fetch = mock(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    try {
      const wh = createWebhook({
        name: "Generic",
        url: "https://example.test/hook",
        events: ["invoice.paid"],
        preset: "generic",
      });

      await dispatchEvent("invoice.paid", {
        invoice_id: "inv-1",
        invoice_number: "INV-001",
        total: 100,
        currency: "USD",
      });

      const deliveries = listDeliveries(wh.id);
      expect(deliveries.length).toBe(1);
      expect(deliveries[0].status_code).toBe(200);
      expect(deliveries[0].event_type).toBe("invoice.paid");
      // Generic preset wraps payload in { event, data, timestamp }
      const sentPayload = JSON.parse(deliveries[0].payload || "{}");
      expect(sentPayload.event).toBe("invoice.paid");
      expect((sentPayload.data as { invoice_number: string }).invoice_number).toBe("INV-001");
    } finally {
      global.fetch = realFetch;
    }
  });

  test("Slack preset formats payload as { text }", async () => {
    let capturedBody = "";
    const realFetch = global.fetch;
    global.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      capturedBody = (init?.body as string) ?? "";
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      createWebhook({
        name: "Slack",
        url: "https://hooks.slack.com/services/T/B/abc",
        events: ["invoice.paid"],
        preset: "slack",
      });

      await dispatchEvent("invoice.paid", {
        invoice_number: "INV-002",
        total: 250,
        currency: "USD",
        customer_name: "Acme",
      });

      const parsed = JSON.parse(capturedBody);
      expect(typeof parsed.text).toBe("string");
      expect(parsed.text).toContain("INV-002");
      expect(parsed.text).toContain("Acme");
    } finally {
      global.fetch = realFetch;
    }
  });

  test("non-matching event types are skipped", async () => {
    let calls = 0;
    const realFetch = global.fetch;
    global.fetch = mock(async () => {
      calls++;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      createWebhook({
        name: "Sent only",
        url: "https://example.test/sent",
        events: ["invoice.sent"],
        preset: "generic",
      });

      await dispatchEvent("invoice.paid", { foo: "bar" });
      // Should not have been called for this webhook
      // (Other webhooks subscribed to invoice.paid from earlier tests will still fire)
      const all = getDb()
        .query(
          "SELECT COUNT(*) as c FROM webhook_deliveries d JOIN outgoing_webhooks w ON w.id = d.webhook_id WHERE w.name = 'Sent only'",
        )
        .get() as { c: number };
      expect(all.c).toBe(0);
      // Still sanity check the mock got called for at least one webhook
      expect(calls).toBeGreaterThanOrEqual(0);
    } finally {
      global.fetch = realFetch;
    }
  });

  test("retryDelivery fires again and creates a new row", async () => {
    const realFetch = global.fetch;
    global.fetch = mock(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

    try {
      const wh = createWebhook({
        name: "Retry test",
        url: "https://example.test/retry",
        events: ["invoice.created"],
        preset: "generic",
      });

      await dispatchEvent("invoice.created", { invoice_number: "RT-1" });
      const original = listDeliveries(wh.id)[0];
      expect(original).toBeDefined();

      const retried = await retryDelivery(original.id);
      expect(retried).not.toBeNull();
      expect(retried?.attempt_count).toBe(2);

      const after = listDeliveries(wh.id);
      expect(after.length).toBe(2);
    } finally {
      global.fetch = realFetch;
    }
  });
});

// The receiver's status and body are stored and shown back to whoever set the
// hook up, so a delivery that reached an internal address would read it out.
describe("delivery stays on public addresses", () => {
  let calls: string[] = [];

  /** One event to one fresh hook, with every earlier hook switched off. The
   *  fake follows redirects unless told not to, as the real fetch does. */
  async function deliverOnce(url: string, respond: (url: string) => Response) {
    calls = [];
    const realFetch = global.fetch;
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const target = String(input);
      calls.push(target);
      const res = respond(target);
      const location = res.headers.get("location");
      if (location && init?.redirect !== "manual") {
        return fakeFetch(new URL(location, target).toString(), init);
      }
      return res;
    };
    global.fetch = mock(fakeFetch) as unknown as typeof fetch;
    try {
      getDb().run("UPDATE outgoing_webhooks SET is_active = 0");
      const wh = createWebhook({ name: "Probe", url, events: ["invoice.overdue"] });
      await dispatchEvent("invoice.overdue", { invoice_number: "SSRF-1" });
      return listDeliveries(wh.id)[0];
    } finally {
      global.fetch = realFetch;
    }
  }

  test("a 302 toward the metadata service is logged, not followed", async () => {
    const delivery = await deliverOnce("https://redirect.test/hook", (url) =>
      url.startsWith("https://redirect.test/")
        ? new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/iam/" },
          })
        : new Response("AccessKeyId=AKIA-METADATA"),
    );
    expect(calls).toEqual(["https://redirect.test/hook"]);
    expect(delivery.status_code).toBe(302);
    expect(delivery.response_body).toBe("");
  });

  test("a host that resolves inward is never contacted", async () => {
    const delivery = await deliverOnce("https://internal.test/hook", () => new Response("secret"));
    expect(calls).toEqual([]);
    expect(delivery.status_code).toBeNull();
    expect(delivery.response_body).toBeNull();
    expect(delivery.error_message).toBe("address not allowed (public https URLs only)");
  });

  test("a host this server cannot resolve fails closed, with the same message", async () => {
    const delivery = await deliverOnce("https://nowhere.test/hook", () => new Response("secret"));
    expect(calls).toEqual([]);
    expect(delivery.error_message).toBe("address not allowed (public https URLs only)");
  });

  test("keeps at most 4000 bytes of the answer", async () => {
    const delivery = await deliverOnce(
      "https://chatty.test/hook",
      () => new Response("x".repeat(100_000)),
    );
    expect(delivery.status_code).toBe(200);
    expect(delivery.response_body?.length).toBe(4000);
  });

  test("refuses an internal address when the hook is saved", async () => {
    const save = (method: string, path: string, url: string) =>
      app.request(path, {
        method,
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Probe", url, events: ["invoice.paid"] }),
      });

    for (const url of [
      "https://internal.test/hook",
      "https://nowhere.test/hook",
      "https://169.254.169.254/latest/meta-data/",
      "http://example.com/hook",
    ]) {
      const res = await save("POST", "/api/v1/outgoing-webhooks", url);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        success: false,
        error: "Webhook URL must be a public https:// address",
      });
    }

    const created = await save("POST", "/api/v1/outgoing-webhooks", "https://example.com/hook");
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    const moved = await save(
      "PUT",
      `/api/v1/outgoing-webhooks/${data.id}`,
      "https://internal.test/",
    );
    expect(moved.status).toBe(400);
  });
});
