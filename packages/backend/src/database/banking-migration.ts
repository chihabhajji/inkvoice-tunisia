import type { Database } from "bun:sqlite";

export function migrateBanking(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS banks (id TEXT PRIMARY KEY, name TEXT NOT NULL, branch TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS bank_accounts (id TEXT PRIMARY KEY, bank_id TEXT NOT NULL REFERENCES banks(id), label TEXT NOT NULL, holder TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'TND', account_number TEXT NOT NULL DEFAULT '', iban TEXT NOT NULL DEFAULT '', bic TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '', is_default INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (NOT (archived = 1 AND is_default = 1)));
    CREATE UNIQUE INDEX IF NOT EXISTS bank_default_currency ON bank_accounts(currency) WHERE is_default = 1 AND archived = 0;
    CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', role TEXT NOT NULL,
      bank_id TEXT REFERENCES banks(id), archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS invoice_delivery_requests (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS invoice_delivery_messages (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES invoice_delivery_requests(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, recipients TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', accepted TEXT NOT NULL DEFAULT '[]', rejected TEXT NOT NULL DEFAULT '[]',
      error TEXT, message_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS invoice_deliveries_invoice ON invoice_delivery_requests(invoice_id, created_at);
  `);
  const columns = db.query("PRAGMA table_info(invoices)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "bank_account_id"))
    db.exec("ALTER TABLE invoices ADD COLUMN bank_account_id TEXT REFERENCES bank_accounts(id)");
  if (!columns.some((c) => c.name === "bank_snapshot"))
    db.exec("ALTER TABLE invoices ADD COLUMN bank_snapshot TEXT");
  const settings = Object.fromEntries(
    (db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[]).map(
      (r) => [r.key, r.value],
    ),
  );
  const details = {
    bank_name: "",
    holder: settings.company_account_holder || settings.company_name || "",
    currency: settings.currency || "TND",
    account_number: "",
    iban: settings.company_iban || "",
    bic: settings.company_bic || "",
    bank_details: settings.company_bank_details || "",
  };
  // Older versions rendered these live settings; preserve the output available at migration time.
  db.run(
    "UPDATE invoices SET bank_snapshot = ? WHERE status != 'draft' AND bank_snapshot IS NULL",
    [JSON.stringify(details)],
  );
  if (details.iban) {
    db.run("INSERT OR IGNORE INTO banks (id, name) VALUES ('imported-bank', 'Imported bank')");
    db.run(
      `INSERT OR IGNORE INTO bank_accounts (id, bank_id, label, holder, currency, iban, bic, instructions, is_default)
      VALUES ('imported-account', 'imported-bank', 'Imported account', ?, ?, ?, ?, ?, 1)`,
      [details.holder, details.currency, details.iban, details.bic, details.bank_details],
    );
  }
}
