import crypto from "node:crypto";
import { getDb } from "../database/connection";
import type { PaginatedResponse } from "../types/common";
import type { Expense } from "../types/expense";
import { todayIso } from "../utils/date";
import { getBaseCurrency } from "./exchange-rate.service";
import { createInvoice } from "./invoice.service";

/** Force rate to 1 when the expense is already in the base currency. */
function resolveExchangeRate(currency: string | undefined, provided: number | undefined): number {
  const cur = (currency || "USD").toUpperCase();
  if (cur === getBaseCurrency().toUpperCase()) return 1;
  return provided && provided > 0 ? provided : 1;
}

interface ExpenseListParams {
  category?: string;
  billable?: string;
  customer_id?: string;
  search?: string;
  date_from?: string;
  date_to?: string;
  page: number;
  limit: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Resolve tax rate from a tax definition (if any) and derive tax_amount + total. */
function deriveTotals(
  amount: number,
  taxId: string | null,
): {
  tax_id: string | null;
  tax_rate: number;
  tax_amount: number;
  total: number;
} {
  const db = getDb();
  let taxRate = 0;
  let resolvedTaxId: string | null = null;
  if (taxId) {
    const taxDef = db.query("SELECT rate FROM tax_definitions WHERE id = ?").get(taxId) as {
      rate: number;
    } | null;
    if (taxDef) {
      taxRate = taxDef.rate;
      resolvedTaxId = taxId;
    }
  }
  const taxAmount = round2((amount * taxRate) / 100);
  return {
    tax_id: resolvedTaxId,
    tax_rate: taxRate,
    tax_amount: taxAmount,
    total: round2(amount + taxAmount),
  };
}

function buildFilters(params: Partial<ExpenseListParams>): {
  where: string;
  queryParams: (string | number)[];
} {
  const conditions: string[] = [];
  const queryParams: (string | number)[] = [];

  if (params.category) {
    conditions.push("e.category = ?");
    queryParams.push(params.category);
  }
  if (params.billable !== undefined) {
    conditions.push("e.is_billable = ?");
    queryParams.push(params.billable === "true" ? 1 : 0);
  }
  if (params.customer_id) {
    conditions.push("e.customer_id = ?");
    queryParams.push(params.customer_id);
  }
  if (params.date_from) {
    conditions.push("e.expense_date >= ?");
    queryParams.push(params.date_from);
  }
  if (params.date_to) {
    conditions.push("e.expense_date <= ?");
    queryParams.push(params.date_to);
  }
  if (params.search) {
    conditions.push("(e.vendor LIKE ? OR e.description LIKE ? OR e.category LIKE ?)");
    queryParams.push(`%${params.search}%`, `%${params.search}%`, `%${params.search}%`);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    queryParams,
  };
}

export interface ExpenseRow extends Expense {
  customer_name: string | null;
  tax_name: string | null;
  /** 1 when a receipt file is attached (see `/expenses/:id/receipt`). */
  has_receipt: number;
}

/** What a client sees about an attached receipt; the bytes come from the receipt endpoint. */
export interface ExpenseReceiptMeta {
  file_name: string;
  content_type: string;
  size: number;
  created_at: string;
}

export interface ExpenseDetail extends ExpenseRow {
  receipt: ExpenseReceiptMeta | null;
}

export function listExpenses(params: ExpenseListParams): PaginatedResponse<ExpenseRow> {
  const db = getDb();
  const { page, limit } = params;
  const offset = (page - 1) * limit;
  const { where, queryParams } = buildFilters(params);

  const countRow = db
    .query(`SELECT COUNT(*) as count FROM expenses e ${where}`)
    .get(...queryParams) as { count: number };

  const items = db
    .query(
      `SELECT e.*, c.name as customer_name, t.name as tax_name,
       EXISTS (SELECT 1 FROM expense_receipts r WHERE r.expense_id = e.id) as has_receipt
       FROM expenses e
       LEFT JOIN customers c ON e.customer_id = c.id
       LEFT JOIN tax_definitions t ON e.tax_id = t.id
       ${where}
       ORDER BY e.expense_date DESC, e.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...queryParams, limit, offset) as ExpenseRow[];

  return {
    items,
    total: countRow.count,
    page,
    limit,
    totalPages: Math.ceil(countRow.count / limit),
  };
}

export function listExpensesForExport(params: Partial<ExpenseListParams>): ExpenseRow[] {
  const db = getDb();
  const { where, queryParams } = buildFilters(params);
  return db
    .query(
      `SELECT e.*, c.name as customer_name, t.name as tax_name,
       EXISTS (SELECT 1 FROM expense_receipts r WHERE r.expense_id = e.id) as has_receipt
       FROM expenses e
       LEFT JOIN customers c ON e.customer_id = c.id
       LEFT JOIN tax_definitions t ON e.tax_id = t.id
       ${where}
       ORDER BY e.expense_date DESC, e.created_at DESC`,
    )
    .all(...queryParams) as ExpenseRow[];
}

export function getExpense(id: string): ExpenseDetail | null {
  const db = getDb();
  const row = db
    .query(
      `SELECT e.*, c.name as customer_name, t.name as tax_name,
       EXISTS (SELECT 1 FROM expense_receipts r WHERE r.expense_id = e.id) as has_receipt
       FROM expenses e
       LEFT JOIN customers c ON e.customer_id = c.id
       LEFT JOIN tax_definitions t ON e.tax_id = t.id
       WHERE e.id = ?`,
    )
    .get(id) as ExpenseRow | null;
  if (!row) return null;
  return { ...row, receipt: getExpenseReceiptMeta(id) };
}

export function createExpense(data: Partial<Expense>): Expense {
  const db = getDb();
  const id = crypto.randomBytes(16).toString("hex");
  const amount = data.amount ?? 0;
  const { tax_id, tax_rate, tax_amount, total } = deriveTotals(amount, data.tax_id || null);

  db.run(
    `INSERT INTO expenses (id, vendor, category, description, expense_date, amount, tax_id,
       tax_rate, tax_amount, total, currency, exchange_rate, receipt_reference, customer_id, is_billable, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.vendor || null,
      data.category || null,
      data.description || null,
      data.expense_date || todayIso(),
      amount,
      tax_id,
      tax_rate,
      tax_amount,
      total,
      data.currency || "USD",
      resolveExchangeRate(data.currency, data.exchange_rate),
      data.receipt_reference || null,
      data.customer_id || null,
      data.is_billable ?? 0,
      data.notes || null,
    ],
  );

  return db.query("SELECT * FROM expenses WHERE id = ?").get(id) as Expense;
}

export function updateExpense(id: string, data: Partial<Expense>): Expense | null {
  const db = getDb();
  const existing = db.query("SELECT id, receipt_reference FROM expenses WHERE id = ?").get(id) as {
    id: string;
    receipt_reference: string | null;
  } | null;
  if (!existing) return null;

  // A client that does not send receipt_reference (the mobile app edits an
  // expense without it) keeps the stored one; an empty string clears it.
  const receiptReference =
    data.receipt_reference === undefined
      ? existing.receipt_reference
      : data.receipt_reference || null;

  const amount = data.amount ?? 0;
  const { tax_id, tax_rate, tax_amount, total } = deriveTotals(amount, data.tax_id || null);

  db.run(
    `UPDATE expenses SET vendor = ?, category = ?, description = ?, expense_date = ?, amount = ?,
       tax_id = ?, tax_rate = ?, tax_amount = ?, total = ?, currency = ?, exchange_rate = ?, receipt_reference = ?,
       customer_id = ?, is_billable = ?, notes = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [
      data.vendor || null,
      data.category || null,
      data.description || null,
      data.expense_date || todayIso(),
      amount,
      tax_id,
      tax_rate,
      tax_amount,
      total,
      data.currency || "USD",
      resolveExchangeRate(data.currency, data.exchange_rate),
      receiptReference,
      data.customer_id || null,
      data.is_billable ?? 0,
      data.notes || null,
      id,
    ],
  );

  return db.query("SELECT * FROM expenses WHERE id = ?").get(id) as Expense;
}

export function deleteExpense(id: string): { success: boolean; error?: string } {
  const db = getDb();
  const existing = db.query("SELECT id FROM expenses WHERE id = ?").get(id);
  if (!existing) return { success: false, error: "Expense not found" };
  db.transaction(() => {
    // The FK cascades too; deleting explicitly keeps it true even on a
    // connection opened without foreign_keys.
    db.run("DELETE FROM expense_receipts WHERE expense_id = ?", [id]);
    db.run("DELETE FROM expenses WHERE id = ?", [id]);
  })();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Receipts: one uploaded file (photo or PDF) per expense, stored as a BLOB.
// ---------------------------------------------------------------------------

export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

export const RECEIPT_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/heic",
  "application/pdf",
] as const;

export type ReceiptContentType = (typeof RECEIPT_CONTENT_TYPES)[number];

const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"]);

/**
 * Identify a receipt by its leading bytes rather than trusting the declared
 * Content-Type, so a renamed HTML or SVG file can never be stored and served
 * back as a "receipt". Returns null for anything that is not one of the
 * accepted formats.
 */
export function sniffReceiptType(bytes: Uint8Array): ReceiptContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "application/pdf";
  }
  // ISO-BMFF: [size:4]["ftyp"][major brand:4]
  if (bytes.length >= 12) {
    const box = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (box === "ftyp" && HEIC_BRANDS.has(brand)) return "image/heic";
  }
  return null;
}

function safeReceiptFileName(name: string | undefined, type: ReceiptContentType): string {
  const ext: Record<ReceiptContentType, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/heic": "heic",
    "application/pdf": "pdf",
  };
  // Keep a readable name but drop path parts, control and quote characters.
  const last = (name || "").split(/[\\/]/).pop() ?? "";
  const base = Array.from(last)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f && ch !== '"';
    })
    .join("")
    .trim()
    .slice(0, 200);
  return base || `receipt.${ext[type]}`;
}

export function getExpenseReceiptMeta(expenseId: string): ExpenseReceiptMeta | null {
  return getDb()
    .query(
      "SELECT file_name, content_type, size, created_at FROM expense_receipts WHERE expense_id = ?",
    )
    .get(expenseId) as ExpenseReceiptMeta | null;
}

export function getExpenseReceipt(
  expenseId: string,
): (ExpenseReceiptMeta & { content: Uint8Array<ArrayBuffer> }) | null {
  const row = getDb()
    .query(
      "SELECT file_name, content_type, size, created_at, content FROM expense_receipts WHERE expense_id = ?",
    )
    .get(expenseId) as (ExpenseReceiptMeta & { content: Uint8Array }) | null;
  return row ? { ...row, content: new Uint8Array(row.content) } : null;
}

export type SaveReceiptResult =
  | { success: true; data: ExpenseReceiptMeta }
  | { success: false; status: 400 | 404 | 413; error: string };

/**
 * Attach (or replace) the receipt for an expense and point
 * `receipt_reference` at it. The stored type is the sniffed one, never the
 * client's claim.
 */
export function saveExpenseReceipt(
  expenseId: string,
  file: { name?: string; bytes: Uint8Array },
): SaveReceiptResult {
  const db = getDb();
  const expense = db.query("SELECT id FROM expenses WHERE id = ?").get(expenseId);
  if (!expense) return { success: false, status: 404, error: "Expense not found" };
  if (file.bytes.length === 0) return { success: false, status: 400, error: "File is empty" };
  if (file.bytes.length > MAX_RECEIPT_BYTES) {
    return { success: false, status: 413, error: "Receipt must be 10 MB or smaller" };
  }
  const type = sniffReceiptType(file.bytes);
  if (!type) {
    return {
      success: false,
      status: 400,
      error: "Unsupported file type. Allowed: JPEG, PNG, HEIC, PDF",
    };
  }
  const fileName = safeReceiptFileName(file.name, type);

  db.transaction(() => {
    db.run(
      `INSERT INTO expense_receipts (expense_id, file_name, content_type, size, content)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(expense_id) DO UPDATE SET file_name = excluded.file_name,
         content_type = excluded.content_type, size = excluded.size,
         content = excluded.content, created_at = datetime('now')`,
      [expenseId, fileName, type, file.bytes.length, file.bytes],
    );
    db.run("UPDATE expenses SET receipt_reference = ?, updated_at = datetime('now') WHERE id = ?", [
      fileName,
      expenseId,
    ]);
  })();

  return { success: true, data: getExpenseReceiptMeta(expenseId)! };
}

/**
 * Remove an expense's receipt. `receipt_reference` is cleared only when it
 * still names the uploaded file, so a reference the user typed by hand
 * afterwards survives.
 */
export function deleteExpenseReceipt(expenseId: string): boolean {
  const db = getDb();
  const meta = getExpenseReceiptMeta(expenseId);
  if (!meta) return false;
  db.transaction(() => {
    db.run("DELETE FROM expense_receipts WHERE expense_id = ?", [expenseId]);
    db.run(
      `UPDATE expenses SET receipt_reference = NULL, updated_at = datetime('now')
       WHERE id = ? AND receipt_reference = ?`,
      [expenseId, meta.file_name],
    );
  })();
  return true;
}

/**
 * Re-bill a billable expense to its linked customer by creating a draft invoice
 * with a single line item derived from the expense. The expense is then stamped
 * with the new invoice's id so it can't be billed twice.
 */
export function rebillExpense(id: string): {
  success: boolean;
  error?: string;
  invoice_id?: string;
} {
  const db = getDb();
  const expense = db.query("SELECT * FROM expenses WHERE id = ?").get(id) as Expense | null;
  if (!expense) return { success: false, error: "Expense not found" };
  if (!expense.is_billable) return { success: false, error: "Expense is not billable" };
  if (!expense.customer_id) return { success: false, error: "Expense has no linked customer" };
  if (expense.billed_invoice_id) return { success: false, error: "Expense already re-billed" };

  const descriptionParts = [expense.vendor, expense.description || expense.category].filter(
    Boolean,
  );
  const description = descriptionParts.join(" — ") || "Expense";

  const invoice = createInvoice({
    customer_id: expense.customer_id,
    issue_date: todayIso(),
    currency: expense.currency,
    items: [
      {
        description,
        quantity: 1,
        unit_price: expense.amount,
        tax_id: expense.tax_id,
      },
    ],
  });

  db.run("UPDATE expenses SET billed_invoice_id = ?, updated_at = datetime('now') WHERE id = ?", [
    invoice.id,
    id,
  ]);

  return { success: true, invoice_id: invoice.id };
}
