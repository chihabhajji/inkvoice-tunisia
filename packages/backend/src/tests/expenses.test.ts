import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { sniffReceiptType } from "../services/expense.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-expenses.db";
let app: Hono;
let token: string;

async function authed(path: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = {
    ...((opts.headers as Record<string, string>) || {}),
    Authorization: `Bearer ${token}`,
  };
  if (!(opts.body instanceof FormData) && opts.method && opts.method !== "GET") {
    headers["Content-Type"] = "application/json";
  }
  return app.request(new Request(`http://localhost${path}`, { ...opts, headers }));
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "testpass123";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();

  initDatabase();
  runMigrations();
  await seed();
  app = createApp();

  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "testpass123" }),
  });
  const data = (await res.json()) as any;
  token = data.data.token;
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {}
  }
});

describe("Expenses", () => {
  let expenseId: string;
  let taxId: string;
  let customerId: string;

  test("setup: tax definition + customer exist", async () => {
    const taxRes = await authed("/api/v1/tax-definitions");
    const taxData = (await taxRes.json()) as any;
    expect(taxData.success).toBe(true);
    expect(taxData.data.length).toBeGreaterThan(0);
    taxId = taxData.data[0].id;

    const custRes = await authed("/api/v1/customers", {
      method: "POST",
      body: JSON.stringify({ name: "Expense Client", email: "ec@example.com" }),
    });
    customerId = ((await custRes.json()) as any).data.id;
  });

  test("create expense computes tax and total", async () => {
    const taxRes = await authed(`/api/v1/tax-definitions`);
    const rate = ((await taxRes.json()) as any).data.find((t: any) => t.id === taxId).rate;

    const res = await authed("/api/v1/expenses", {
      method: "POST",
      body: JSON.stringify({
        vendor: "Acme Supplies",
        category: "Office",
        expense_date: "2026-05-01",
        amount: 100,
        tax_id: taxId,
        currency: "USD",
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    expect(data.success).toBe(true);
    expenseId = data.data.id;
    expect(data.data.tax_rate).toBe(rate);
    expect(data.data.tax_amount).toBeCloseTo((100 * rate) / 100, 2);
    expect(data.data.total).toBeCloseTo(100 + (100 * rate) / 100, 2);
  });

  test("list and filter by billable", async () => {
    const all = await authed("/api/v1/expenses");
    const allData = (await all.json()) as any;
    expect(allData.data.total).toBe(1);

    const billable = await authed("/api/v1/expenses?billable=true");
    expect(((await billable.json()) as any).data.total).toBe(0);
  });

  test("update expense to billable + linked customer", async () => {
    const res = await authed(`/api/v1/expenses/${expenseId}`, {
      method: "PUT",
      body: JSON.stringify({
        vendor: "Acme Supplies",
        category: "Office",
        expense_date: "2026-05-01",
        amount: 100,
        tax_id: taxId,
        currency: "USD",
        customer_id: customerId,
        is_billable: 1,
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.data.is_billable).toBe(1);
    expect(data.data.customer_id).toBe(customerId);
  });

  test("rebill creates an invoice and stamps the expense", async () => {
    const res = await authed(`/api/v1/expenses/${expenseId}/rebill`, { method: "POST" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.success).toBe(true);
    const invoiceId = data.data.invoice_id;
    expect(invoiceId).toBeTruthy();

    const inv = await authed(`/api/v1/invoices/${invoiceId}`);
    const invData = (await inv.json()) as any;
    expect(invData.data.customer_id).toBe(customerId);
    expect(invData.data.items.length).toBe(1);
    expect(invData.data.items[0].unit_price).toBe(100);

    // Second rebill must fail (already billed).
    const again = await authed(`/api/v1/expenses/${expenseId}/rebill`, { method: "POST" });
    expect(again.status).toBe(409);
  });

  test("expenses-by-category report", async () => {
    const res = await authed("/api/v1/reports/expenses-by-category");
    const data = (await res.json()) as any;
    expect(data.success).toBe(true);
    const office = data.data.rows.find((r: any) => r.category === "Office");
    expect(office).toBeTruthy();
    expect(office.count).toBe(1);
    expect(data.data.total).toBeGreaterThan(0);
  });

  test("profit-loss report subtracts expenses from revenue", async () => {
    const res = await authed("/api/v1/reports/profit-loss");
    const data = (await res.json()) as any;
    expect(data.success).toBe(true);
    expect(data.data.expenses).toBeGreaterThan(0);
    expect(data.data.net).toBe(data.data.revenue - data.data.expenses);
  });

  test("dashboard stats expose total_expenses and net_income", async () => {
    const res = await authed("/api/v1/dashboard/stats");
    const data = (await res.json()) as any;
    expect(data.data.total_expenses).toBeGreaterThan(0);
    expect(data.data.net_income).toBe(data.data.total_revenue - data.data.total_expenses);
  });

  test("CSV export includes the expense", async () => {
    const res = await authed("/api/v1/expenses/export/csv");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Acme Supplies");
  });

  test("delete expense", async () => {
    const res = await authed(`/api/v1/expenses/${expenseId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const after = await authed("/api/v1/expenses");
    expect(((await after.json()) as any).data.total).toBe(0);
  });
});

describe("Expense receipts", () => {
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  const PDF = new TextEncoder().encode("%PDF-1.4\n%receipt\n");

  async function newExpense(): Promise<string> {
    const res = await authed("/api/v1/expenses", {
      method: "POST",
      body: JSON.stringify({ vendor: "Receipt Shop", expense_date: "2026-05-01", amount: 12 }),
    });
    return ((await res.json()) as any).data.id;
  }

  function upload(
    id: string,
    bytes: Uint8Array<ArrayBuffer>,
    name: string,
    type: string,
    field = "file",
  ) {
    const form = new FormData();
    form.append(field, new File([bytes], name, { type }));
    return authed(`/api/v1/expenses/${id}/receipt`, { method: "POST", body: form });
  }

  test("uploads, serves, replaces and deletes a receipt", async () => {
    const id = await newExpense();

    const up = await upload(id, PNG, "lunch.png", "image/png");
    expect(up.status).toBe(201);
    const upData = ((await up.json()) as any).data;
    expect(upData.id).toBe(id);
    expect(upData.receipt_reference).toBe("lunch.png");
    expect(upData.has_receipt).toBe(1);
    expect(upData.receipt).toMatchObject({
      file_name: "lunch.png",
      content_type: "image/png",
      size: PNG.length,
    });

    const list = await authed("/api/v1/expenses?search=Receipt%20Shop");
    const row = ((await list.json()) as any).data.items.find((e: any) => e.id === id);
    expect(row.has_receipt).toBe(1);

    const get = await authed(`/api/v1/expenses/${id}/receipt`);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("image/png");
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.headers.get("content-disposition")).toContain("inline");
    expect(get.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(PNG);

    const dl = await authed(`/api/v1/expenses/${id}/receipt?download=1`);
    expect(dl.headers.get("content-disposition")).toContain("attachment");

    // Replace with a PDF; the type comes from the bytes, not the label.
    const re = await upload(id, PDF, "invoice.pdf", "application/octet-stream", "receipt");
    expect(re.status).toBe(201);
    const reData = ((await re.json()) as any).data;
    expect(reData.receipt.content_type).toBe("application/pdf");
    expect(reData.receipt_reference).toBe("invoice.pdf");

    const del = await authed(`/api/v1/expenses/${id}/receipt`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const delData = ((await del.json()) as any).data;
    expect(delData.receipt).toBeNull();
    expect(delData.has_receipt).toBe(0);
    expect(delData.receipt_reference).toBeNull();

    expect((await authed(`/api/v1/expenses/${id}/receipt`)).status).toBe(404);
    expect((await authed(`/api/v1/expenses/${id}/receipt`, { method: "DELETE" })).status).toBe(404);
  });

  test("an expense edit that omits receipt_reference keeps it", async () => {
    const id = await newExpense();
    await upload(id, PNG, "kept.png", "image/png");
    const put = await authed(`/api/v1/expenses/${id}`, {
      method: "PUT",
      body: JSON.stringify({ vendor: "Renamed", expense_date: "2026-05-02", amount: 15 }),
    });
    const data = ((await put.json()) as any).data;
    expect(data.vendor).toBe("Renamed");
    expect(data.receipt_reference).toBe("kept.png");
  });

  test("deleting a receipt keeps a hand-typed reference", async () => {
    const id = await newExpense();
    await upload(id, PNG, "scan.png", "image/png");
    await authed(`/api/v1/expenses/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        expense_date: "2026-05-01",
        amount: 12,
        receipt_reference: "Box 4, folder 2",
      }),
    });
    await authed(`/api/v1/expenses/${id}/receipt`, { method: "DELETE" });
    const get = await authed(`/api/v1/expenses/${id}`);
    expect(((await get.json()) as any).data.receipt_reference).toBe("Box 4, folder 2");
  });

  test("rejects files that are not JPEG, PNG, HEIC or PDF", async () => {
    const id = await newExpense();
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const res = await upload(id, html, "evil.png", "image/png");
    expect(res.status).toBe(400);
    expect((await authed(`/api/v1/expenses/${id}/receipt`)).status).toBe(404);
  });

  test("rejects a missing file, an empty file and an oversized file", async () => {
    const id = await newExpense();
    const none = await authed(`/api/v1/expenses/${id}/receipt`, {
      method: "POST",
      body: new FormData(),
    });
    expect(none.status).toBe(400);

    expect((await upload(id, new Uint8Array(0), "empty.png", "image/png")).status).toBe(400);

    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    expect((await upload(id, big, "big.png", "image/png")).status).toBe(413);
  });

  test("returns 404 for an unknown expense", async () => {
    const res = await upload("does-not-exist", PNG, "x.png", "image/png");
    expect(res.status).toBe(404);
    expect((await authed("/api/v1/expenses/does-not-exist/receipt")).status).toBe(404);
  });

  test("requires authentication", async () => {
    const id = await newExpense();
    const res = await app.request(`/api/v1/expenses/${id}/receipt`);
    expect(res.status).toBe(401);
  });

  test("deleting the expense removes its receipt", async () => {
    const id = await newExpense();
    await upload(id, PNG, "gone.png", "image/png");
    const del = await authed(`/api/v1/expenses/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const row = getDb()
      .query("SELECT COUNT(*) as c FROM expense_receipts WHERE expense_id = ?")
      .get(id) as { c: number };
    expect(row.c).toBe(0);
  });

  test("sniffReceiptType recognises each accepted format", () => {
    expect(sniffReceiptType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffReceiptType(PNG)).toBe("image/png");
    expect(sniffReceiptType(PDF)).toBe("application/pdf");
    const heic = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic")]);
    expect(sniffReceiptType(heic)).toBe("image/heic");
    const mp4 = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypisom")]);
    expect(sniffReceiptType(mp4)).toBeNull();
    expect(sniffReceiptType(new TextEncoder().encode("GIF89a"))).toBeNull();
  });
});
