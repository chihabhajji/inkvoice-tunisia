import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-public-invoice.db";
let app: Hono;
let token: string;
let publishedShareToken: string;
let voidedShareToken: string;
let customerId: string;

async function authed(path: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = {
    ...((opts.headers as Record<string, string>) || {}),
    Authorization: `Bearer ${token}`,
  };
  if (opts.method && opts.method !== "GET") headers["Content-Type"] = "application/json";
  return app.request(new Request(`http://localhost${path}`, { ...opts, headers }));
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "publicroutetestpass";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();

  initDatabase();
  runMigrations();
  await seed();
  app = createApp();

  // Login
  const loginRes = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "publicroutetestpass" }),
  });
  token = ((await loginRes.json()) as any).data.token;

  // Customer
  const cRes = await authed("/api/v1/customers", {
    method: "POST",
    body: JSON.stringify({ name: "Public Tester" }),
  });
  customerId = ((await cRes.json()) as any).data.id;

  // Invoice 1: marked sent then published normally
  const inv1 = await authed("/api/v1/invoices", {
    method: "POST",
    body: JSON.stringify({
      customer_id: customerId,
      issue_date: "2026-01-15",
      items: [{ description: "Service", quantity: 1, unit_price: 100, tax_rate: 0 }],
    }),
  });
  const inv1Id = ((await inv1.json()) as any).data.id;
  await authed(`/api/v1/invoices/${inv1Id}/mark-sent`, { method: "POST" });
  const pub1 = await authed(`/api/v1/invoices/${inv1Id}/publish`, { method: "POST" });
  publishedShareToken = ((await pub1.json()) as any).data.share_token;

  // Invoice 2: marked sent, published, then voided
  const inv2 = await authed("/api/v1/invoices", {
    method: "POST",
    body: JSON.stringify({
      customer_id: customerId,
      issue_date: "2026-02-01",
      items: [{ description: "Other", quantity: 1, unit_price: 50, tax_rate: 0 }],
    }),
  });
  const inv2Id = ((await inv2.json()) as any).data.id;
  await authed(`/api/v1/invoices/${inv2Id}/mark-sent`, { method: "POST" });
  const pub2 = await authed(`/api/v1/invoices/${inv2Id}/publish`, { method: "POST" });
  voidedShareToken = ((await pub2.json()) as any).data.share_token;
  await authed(`/api/v1/invoices/${inv2Id}/void`, { method: "POST" });
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

describe("public invoice route", () => {
  test("valid share token returns invoice", async () => {
    const res = await app.request(`/api/v1/public/invoices/${publishedShareToken}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.success).toBe(true);
    expect(data.data.invoice.invoice_number).toBeDefined();
  });

  test("invalid (random) token returns 404", async () => {
    const res = await app.request("/api/v1/public/invoices/0000000000000000abcdef0000000000");
    expect(res.status).toBe(404);
  });

  test("malformed token returns 404 (not 500)", async () => {
    const res = await app.request("/api/v1/public/invoices/not-a-real-hex-token");
    expect(res.status).toBe(404);
  });

  test("voided invoice is not accessible via public route", async () => {
    // Voiding an invoice removes it from public visibility — share token
    // remains in the DB but the lookup filters it out.
    const res = await app.request(`/api/v1/public/invoices/${voidedShareToken}`);
    expect(res.status).toBe(404);
  });

  test("paying a voided invoice via /pay is rejected", async () => {
    const res = await app.request(`/api/v1/public/invoices/${voidedShareToken}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    // 400 (voided/payments disabled) or 404 (not found) — both are correct refusals.
    expect([400, 404]).toContain(res.status);
  });
});

describe("public share links for partially paid invoices", () => {
  async function partlyPaidInvoice(): Promise<string> {
    const res = await authed("/api/v1/invoices", {
      method: "POST",
      body: JSON.stringify({
        customer_id: customerId,
        issue_date: "2026-03-01",
        items: [{ description: "Partly paid", quantity: 1, unit_price: 200, tax_rate: 0 }],
      }),
    });
    const id = ((await res.json()) as any).data.id;
    await authed(`/api/v1/invoices/${id}/mark-sent`, { method: "POST" });
    const pay = await authed(`/api/v1/invoices/${id}/payments`, {
      method: "POST",
      body: JSON.stringify({ amount: 80, payment_date: "2026-03-05", method: "cash" }),
    });
    expect(pay.status).toBe(201);
    const inv = await authed(`/api/v1/invoices/${id}`);
    expect(((await inv.json()) as any).data.status).toBe("partially_paid");
    return id;
  }

  test("a partially paid invoice can be published and viewed with its balance", async () => {
    const id = await partlyPaidInvoice();
    const pub = await authed(`/api/v1/invoices/${id}/publish`, { method: "POST" });
    expect(pub.status).toBe(200);
    const shareToken = ((await pub.json()) as any).data.share_token;
    expect(shareToken).toBeTruthy();

    const res = await app.request(`/api/v1/public/invoices/${shareToken}`);
    expect(res.status).toBe(200);
    const data = ((await res.json()) as any).data;
    expect(data.invoice.status).toBe("partially_paid");
    expect(data.invoice.total - data.invoice.amount_paid).toBe(120);

    const preview = await app.request(`/api/v1/public/invoices/${shareToken}/preview`);
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain("Balance Due");
    expect(html).toContain("120");
  });

  test("a published link keeps working after a part payment", async () => {
    const res = await authed("/api/v1/invoices", {
      method: "POST",
      body: JSON.stringify({
        customer_id: customerId,
        issue_date: "2026-03-02",
        items: [{ description: "Paid later", quantity: 1, unit_price: 100, tax_rate: 0 }],
      }),
    });
    const id = ((await res.json()) as any).data.id;
    await authed(`/api/v1/invoices/${id}/mark-sent`, { method: "POST" });
    const pub = await authed(`/api/v1/invoices/${id}/publish`, { method: "POST" });
    const shareToken = ((await pub.json()) as any).data.share_token;
    await authed(`/api/v1/invoices/${id}/payments`, {
      method: "POST",
      body: JSON.stringify({ amount: 40, payment_date: "2026-03-06", method: "cash" }),
    });

    const view = await app.request(`/api/v1/public/invoices/${shareToken}`);
    expect(view.status).toBe(200);
    expect(((await view.json()) as any).data.invoice.status).toBe("partially_paid");
  });

  test("a draft still cannot be published", async () => {
    const res = await authed("/api/v1/invoices", {
      method: "POST",
      body: JSON.stringify({
        customer_id: customerId,
        issue_date: "2026-03-03",
        items: [{ description: "Draft", quantity: 1, unit_price: 10, tax_rate: 0 }],
      }),
    });
    const id = ((await res.json()) as any).data.id;
    const pub = await authed(`/api/v1/invoices/${id}/publish`, { method: "POST" });
    expect(pub.status).toBe(400);
  });
});
