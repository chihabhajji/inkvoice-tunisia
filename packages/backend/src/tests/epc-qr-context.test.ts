import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { BUILTIN_TEMPLATES, readTemplateFile } from "../services/builtin-templates";
import { createCustomer } from "../services/customer.service";
import { createInvoice, markSent } from "../services/invoice.service";
import { recordPayment } from "../services/payment.service";
import { buildInvoiceContext, buildQuoteContext } from "../services/pdf.service";
import { createQuote } from "../services/quote.service";
import { updateSettings } from "../services/settings.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-epc-context.db";

const BANK_SETTINGS = {
  company_name: "Pigon Tech GmbH",
  company_iban: "DE89 3704 0044 0532 0130 00",
  company_bic: "COBADEFFXXX",
  company_account_holder: "",
  pdf_epc_qr_enabled: "true",
  currency: "EUR",
};

let customerId: string;

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
  customerId = createCustomer({ name: "Kunde GmbH" }).id;
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {}
  }
});

beforeEach(() => {
  updateSettings(BANK_SETTINGS);
});

function newInvoice(overrides: Record<string, unknown> = {}) {
  const invoice = createInvoice({
    customer_id: customerId,
    issue_date: "2026-03-01",
    currency: "EUR",
    items: [{ description: "Beratung", quantity: 1, unit_price: 500 }],
    ...overrides,
  });
  markSent(invoice.id);
  return invoice;
}

describe("epc_qr template context", () => {
  test("is present on a EUR invoice once bank details are configured", () => {
    const invoice = newInvoice();
    const ctx = buildInvoiceContext(invoice.id);
    expect(ctx?.epc_qr).not.toBeNull();
    expect(ctx?.epc_qr?.image).toStartWith("data:image/svg+xml;base64,");
  });

  test("is absent when the feature is switched off", () => {
    updateSettings({ pdf_epc_qr_enabled: "false" });
    expect(buildInvoiceContext(newInvoice().id)?.epc_qr).toBeNull();
  });

  test("is absent when no IBAN is configured", () => {
    updateSettings({ company_iban: "" });
    expect(buildInvoiceContext(newInvoice().id)?.epc_qr).toBeNull();
  });

  test("is absent when the configured IBAN is invalid", () => {
    updateSettings({ company_iban: "DE00000000000000000000" });
    expect(buildInvoiceContext(newInvoice().id)?.epc_qr).toBeNull();
  });

  test("is absent for a non-EUR invoice", () => {
    const invoice = newInvoice({ currency: "USD" });
    expect(buildInvoiceContext(invoice.id)?.epc_qr).toBeNull();
  });

  test("is absent once the invoice is fully paid", () => {
    const invoice = newInvoice();
    recordPayment(invoice.id, { amount: 500, payment_date: "2026-03-05" });
    expect(buildInvoiceContext(invoice.id)?.epc_qr).toBeNull();
  });

  test("encodes the outstanding balance, not the invoice total", () => {
    const invoice = newInvoice();
    recordPayment(invoice.id, { amount: 200, payment_date: "2026-03-05" });
    const payload = buildInvoiceContext(invoice.id)?.epc_qr?.payload;
    expect(payload).toContain("EUR300.00");
  });

  test("preserves the issued holder while new invoices use the updated holder", () => {
    const invoice = newInvoice();
    expect(buildInvoiceContext(invoice.id)?.epc_qr?.payload).toContain("Pigon Tech GmbH");

    updateSettings({ company_account_holder: "Pigon Tech GmbH & Co. KG" });
    expect(buildInvoiceContext(invoice.id)?.epc_qr?.payload).not.toContain(
      "Pigon Tech GmbH & Co. KG",
    );
    expect(buildInvoiceContext(newInvoice().id)?.epc_qr?.payload).toContain(
      "Pigon Tech GmbH & Co. KG",
    );
  });

  test("references the invoice number so the payment can be reconciled", () => {
    const invoice = newInvoice();
    const ctx = buildInvoiceContext(invoice.id);
    // The number is assigned on publish, so read it back rather than using the
    // draft placeholder the create call returned.
    expect(ctx?.invoice_number).toStartWith("INV-");
    expect(ctx?.epc_qr?.payload).toContain(ctx!.invoice_number);
  });

  test("is never attached to a quote — a quote is not a payment request", () => {
    const quote = createQuote({
      customer_id: customerId,
      issue_date: "2026-03-01",
      currency: "EUR",
      items: [{ description: "Beratung", quantity: 1, unit_price: 500 }],
    });
    const ctx = buildQuoteContext(quote.id) as Record<string, unknown> | null;
    expect(ctx).not.toBeNull();
    expect(ctx?.epc_qr).toBeUndefined();
  });
});

describe("built-in templates", () => {
  test("every built-in template renders the EPC QR block", () => {
    // The setting is useless if no shipped template has the tag, and the block
    // is inert until the tenant enables it, so all four carry it.
    for (const tmpl of BUILTIN_TEMPLATES) {
      const html = readTemplateFile(tmpl.file);
      expect(html).toContain("{{#epc_qr}}");
      expect(html).toContain("{{epc_qr.image}}");
      expect(html).toContain("{{/epc_qr}}");
    }
  });
});
