import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { createApp } from "../app";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { createCustomer } from "../services/customer.service";
import { createInvoice, getInvoice, markSent, updateInvoice } from "../services/invoice.service";
import { deletePayment, recordPayment } from "../services/payment.service";
import { cashDiscountDeadline, cashDiscountOn, hasCashDiscount } from "../utils/cash-discount";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-cash-discount.db";

function makeInvoice(
  customerId: string,
  opts?: {
    issueDate?: string;
    cashDiscountType?: string;
    cashDiscountValue?: number;
    cashDiscountDays?: number;
  },
) {
  const inv = createInvoice({
    customer_id: customerId,
    issue_date: opts?.issueDate || "2026-01-01",
    items: [{ description: "Work", quantity: 1, unit_price: 200 }],
    cash_discount_type: opts?.cashDiscountType ?? "percentage",
    cash_discount_value: opts?.cashDiscountValue ?? 0,
    cash_discount_days: opts?.cashDiscountDays ?? 0,
  });
  markSent(inv.id);
  return inv;
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "testpass123";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  resetEnvCache();
  initDatabase();
  runMigrations();
  await seed();
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {}
  }
});

describe("cash discount maths", () => {
  test("disabled when days is 0 or value is 0", () => {
    expect(hasCashDiscount({ type: "percentage", value: 2, days: 0 })).toBe(false);
    expect(hasCashDiscount({ type: "percentage", value: 0, days: 10 })).toBe(false);
    expect(hasCashDiscount({ type: "percentage", value: 2, days: 10 })).toBe(true);
  });

  test("percentage discount scales with the amount", () => {
    expect(cashDiscountOn(200, { type: "percentage", value: 2, days: 10 })).toBe(4);
    expect(cashDiscountOn(75.5, { type: "percentage", value: 2, days: 10 })).toBe(1.51);
  });

  test("flat discount is capped at the amount", () => {
    expect(cashDiscountOn(200, { type: "amount", value: 25, days: 10 })).toBe(25);
    expect(cashDiscountOn(10, { type: "amount", value: 25, days: 10 })).toBe(10);
  });

  test("deadline is issue date plus days", () => {
    expect(cashDiscountDeadline("2026-01-01", 14)).toBe("2026-01-15");
  });
});

describe("cash discount on invoices", () => {
  test("persists and exposes the discount fields", () => {
    const customer = createCustomer({ name: "Acme" });
    const inv = createInvoice({
      customer_id: customer.id,
      issue_date: "2026-01-01",
      items: [{ description: "Work", quantity: 1, unit_price: 100 }],
      cash_discount_type: "percentage",
      cash_discount_value: 2,
      cash_discount_days: 14,
    });
    const loaded = getInvoice(inv.id)!;
    expect(loaded.cash_discount_type).toBe("percentage");
    expect(loaded.cash_discount_value).toBe(2);
    expect(loaded.cash_discount_days).toBe(14);
  });

  test("settles for less when paid inside the window", () => {
    const customer = createCustomer({ name: "Beta" });
    const inv = makeInvoice(customer.id, { cashDiscountValue: 5, cashDiscountDays: 14 }); // total 200, 5% = 10
    const res = recordPayment(inv.id, {
      amount: 190, // 200 - 10 discount
      payment_date: "2026-01-10",
      apply_cash_discount: true,
    });
    expect(res.success).toBe(true);
    const loaded = getInvoice(inv.id)!;
    expect(loaded.status).toBe("paid");
    expect(loaded.amount_paid).toBe(190);
    expect(loaded.cash_discount_applied).toBe(10);
  });

  test("rejects application after the window passes", () => {
    const customer = createCustomer({ name: "Gamma" });
    const inv = makeInvoice(customer.id, { cashDiscountValue: 5, cashDiscountDays: 14 });
    const res = recordPayment(inv.id, {
      amount: 190,
      payment_date: "2026-02-01",
      apply_cash_discount: true,
    });
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toContain("window");
  });

  test("rejects application when no discount is configured", () => {
    const customer = createCustomer({ name: "Delta" });
    const inv = makeInvoice(customer.id, { cashDiscountDays: 0 });
    const res = recordPayment(inv.id, {
      amount: 190,
      payment_date: "2026-01-10",
      apply_cash_discount: true,
    });
    expect(res.success).toBe(false);
  });

  test("rejects an amount that does not match the discounted balance", () => {
    const customer = createCustomer({ name: "Epsilon" });
    const inv = makeInvoice(customer.id, { cashDiscountValue: 5, cashDiscountDays: 14 });
    const res = recordPayment(inv.id, {
      amount: 150,
      payment_date: "2026-01-10",
      apply_cash_discount: true,
    });
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toContain("discounted balance");
  });

  test("a payment without the flag is recorded at full amount", () => {
    const customer = createCustomer({ name: "Zeta" });
    const inv = makeInvoice(customer.id, { cashDiscountValue: 5, cashDiscountDays: 14 });
    const res = recordPayment(inv.id, { amount: 200, payment_date: "2026-01-10" });
    expect(res.success).toBe(true);
    expect(getInvoice(inv.id)!.status).toBe("paid");
    expect(getInvoice(inv.id)!.cash_discount_applied).toBe(0);
  });

  test("deleting a discount payment restores the unsettled balance", () => {
    const customer = createCustomer({ name: "Eta" });
    const inv = makeInvoice(customer.id, { cashDiscountValue: 5, cashDiscountDays: 14 });
    const res = recordPayment(inv.id, {
      amount: 190,
      payment_date: "2026-01-10",
      apply_cash_discount: true,
    });
    expect(res.success).toBe(true);
    if (!res.success) return;
    deletePayment(res.data.id);
    const loaded = getInvoice(inv.id)!;
    expect(loaded.amount_paid).toBe(0);
    expect(loaded.cash_discount_applied).toBe(0); // discount relinquished with the payment
    expect(loaded.status).toBe("sent");
  });
});

describe("cash discount on draft edits", () => {
  const baseUpdate = (customerId: string) => ({
    customer_id: customerId,
    issue_date: "2026-01-01",
    items: [{ description: "Work, revised", quantity: 2, unit_price: 100 }],
  });

  function draftWithDiscount(customerId: string) {
    return createInvoice({
      customer_id: customerId,
      issue_date: "2026-01-01",
      items: [{ description: "Work", quantity: 1, unit_price: 200 }],
      cash_discount_type: "percentage",
      cash_discount_value: 3,
      cash_discount_days: 10,
    });
  }

  test("an update that omits the cash-discount fields keeps them", () => {
    const customer = createCustomer({ name: "Keep Co" });
    const inv = draftWithDiscount(customer.id);
    const updated = updateInvoice(inv.id, baseUpdate(customer.id))!;
    expect(updated.items[0].description).toBe("Work, revised");
    expect(updated.cash_discount_type).toBe("percentage");
    expect(updated.cash_discount_value).toBe(3);
    expect(updated.cash_discount_days).toBe(10);
  });

  test("an update with explicit nulls clears them", () => {
    const customer = createCustomer({ name: "Clear Co" });
    const inv = draftWithDiscount(customer.id);
    const updated = updateInvoice(inv.id, {
      ...baseUpdate(customer.id),
      cash_discount_type: null,
      cash_discount_value: null,
      cash_discount_days: null,
    })!;
    expect(updated.cash_discount_type).toBeNull();
    expect(updated.cash_discount_value).toBe(0);
    expect(updated.cash_discount_days).toBe(0);
  });

  test("an update can change the values", () => {
    const customer = createCustomer({ name: "Change Co" });
    const inv = draftWithDiscount(customer.id);
    const updated = updateInvoice(inv.id, {
      ...baseUpdate(customer.id),
      cash_discount_type: "amount",
      cash_discount_value: 15,
      cash_discount_days: 7,
    })!;
    expect(updated.cash_discount_type).toBe("amount");
    expect(updated.cash_discount_value).toBe(15);
    expect(updated.cash_discount_days).toBe(7);
  });

  test("PUT /api/v1/invoices/:id keeps omitted fields and clears null ones", async () => {
    const app = createApp();
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "testpass123" }),
    });
    const token = ((await login.json()) as any).data.token;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const customer = createCustomer({ name: "Route Co" });

    // Create through the API so the schema has to pass the fields through.
    const created = await app.request("/api/v1/invoices", {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...baseUpdate(customer.id),
        cash_discount_type: "percentage",
        cash_discount_value: 2,
        cash_discount_days: 14,
      }),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as any).data.id;
    expect(getInvoice(id)!.cash_discount_days).toBe(14);

    const kept = await app.request(`/api/v1/invoices/${id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...baseUpdate(customer.id), notes: "edited" }),
    });
    expect(kept.status).toBe(200);
    const keptData = ((await kept.json()) as any).data;
    expect(keptData.notes).toBe("edited");
    expect(keptData.cash_discount_type).toBe("percentage");
    expect(keptData.cash_discount_value).toBe(2);
    expect(keptData.cash_discount_days).toBe(14);

    const cleared = await app.request(`/api/v1/invoices/${id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        ...baseUpdate(customer.id),
        cash_discount_type: null,
        cash_discount_value: null,
        cash_discount_days: null,
      }),
    });
    expect(cleared.status).toBe(200);
    const clearedData = ((await cleared.json()) as any).data;
    expect(clearedData.cash_discount_type).toBeNull();
    expect(clearedData.cash_discount_value).toBe(0);
    expect(clearedData.cash_discount_days).toBe(0);
  });
});
