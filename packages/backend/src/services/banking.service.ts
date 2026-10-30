import crypto from "node:crypto";
import type {
  AccountInput,
  Bank,
  BankAccount,
  BankInput,
  Contact,
  ContactInput,
  PaymentDetails,
} from "../contracts/banking";
import { getDb } from "../database/connection";
import type { PaginatedResponse } from "../types/common";
import { HttpError } from "../utils/http-error";
import { getAllSettings } from "./settings.service";

type Collection = "banks" | "bank_accounts" | "contacts";
type RecordType = { banks: Bank; bank_accounts: BankAccount; contacts: Contact };
const selections = {
  banks: "SELECT r.* FROM banks r",
  bank_accounts:
    "SELECT r.*, b.name AS bank_name FROM bank_accounts r JOIN banks b ON b.id = r.bank_id",
  contacts: "SELECT r.*, b.name AS bank_name FROM contacts r LEFT JOIN banks b ON b.id = r.bank_id",
};
function decode<T>(row: unknown): T {
  const result = row as Record<string, unknown>;
  return {
    ...result,
    archived: !!result.archived,
    ...("is_default" in result ? { is_default: !!result.is_default } : {}),
  } as T;
}
export function getBankingRecord<K extends Collection>(collection: K, id: string): RecordType[K] {
  const row = getDb().query(`${selections[collection]} WHERE r.id = ?`).get(id);
  if (!row) throw new HttpError(404, "Record not found", undefined, "NOT_FOUND");
  return decode<RecordType[K]>(row);
}
export function listBanking<K extends Collection>(
  collection: K,
  params: {
    page: number;
    limit: number;
    archived?: boolean;
    currency?: string;
    bank_id?: string;
    search?: string;
  },
): PaginatedResponse<RecordType[K]> {
  const conditions = ["1=1"];
  const values: (string | number)[] = [];
  if (params.archived !== undefined) {
    conditions.push("r.archived = ?");
    values.push(Number(params.archived));
  }
  if (params.currency && collection === "bank_accounts") {
    conditions.push("r.currency = ?");
    values.push(params.currency);
  }
  if (params.bank_id && collection !== "banks") {
    conditions.push("r.bank_id = ?");
    values.push(params.bank_id);
  }
  if (params.search) {
    conditions.push(`r.${collection === "bank_accounts" ? "label" : "name"} LIKE ?`);
    values.push(`%${params.search}%`);
  }
  const query = `${selections[collection]} WHERE ${conditions.join(" AND ")}`;
  const total = (
    getDb()
      .query(`SELECT COUNT(*) AS total FROM (${query})`)
      .get(...values) as { total: number }
  ).total;
  const rows = getDb()
    .query(`${query} ORDER BY r.created_at, r.id LIMIT ? OFFSET ?`)
    .all(...values, params.limit, (params.page - 1) * params.limit);
  return {
    items: rows.map((row) => decode<RecordType[K]>(row)),
    total,
    page: params.page,
    limit: params.limit,
    totalPages: Math.ceil(total / params.limit),
  };
}
function save<K extends Collection>(
  collection: K,
  input: BankInput | AccountInput | ContactInput,
  id?: string,
): RecordType[K] {
  const columns = {
    banks: ["name", "branch", "archived"],
    bank_accounts: [
      "bank_id",
      "label",
      "holder",
      "currency",
      "account_number",
      "iban",
      "bic",
      "instructions",
      "is_default",
      "archived",
    ],
    contacts: ["name", "email", "phone", "bank_id", "archived"],
  };
  const keys = columns[collection];
  const values = keys.map((key) => {
    const value = (input as unknown as Record<string, string | boolean | null>)[key];
    return typeof value === "boolean" ? Number(value) : value;
  });
  const key = id || crypto.randomUUID();
  if (id)
    getDb().run(
      `UPDATE ${collection} SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`,
      [...values, id],
    );
  else
    getDb().run(
      `INSERT INTO ${collection} (id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`,
      [key, ...values],
    );
  return getBankingRecord(collection, key);
}
export function saveBank(input: BankInput, id?: string): Bank {
  if (id) getBankingRecord("banks", id);
  if (
    id &&
    input.archived &&
    getDb().query("SELECT id FROM bank_accounts WHERE bank_id = ? AND archived = 0 LIMIT 1").get(id)
  ) {
    throw new HttpError(409, "Archive this bank's accounts first", undefined, "CONFLICT");
  }
  return save("banks", input, id);
}
export function saveAccount(input: AccountInput, id?: string): BankAccount {
  const previous = id ? getBankingRecord("bank_accounts", id) : null;
  const bank = getBankingRecord("banks", input.bank_id);
  if (bank.archived && !input.archived)
    throw new HttpError(400, "Choose an active bank", undefined, "VALIDATION_FAILED");
  if (!input.account_number && !input.iban)
    throw new HttpError(400, "Enter a RIB/account number or IBAN", undefined, "VALIDATION_FAILED");
  if (input.archived && input.is_default)
    throw new HttpError(
      409,
      "Clear or replace the default before archiving",
      undefined,
      "CONFLICT",
    );
  if (
    previous &&
    previous.currency !== input.currency &&
    getDb()
      .query("SELECT id FROM invoices WHERE bank_account_id = ? AND status = 'draft' LIMIT 1")
      .get(id!)
  ) {
    throw new HttpError(
      409,
      "This account's currency is used by draft invoices",
      undefined,
      "CONFLICT",
    );
  }
  return getDb().transaction(() => {
    if (input.is_default)
      getDb().run(
        "UPDATE bank_accounts SET is_default = 0, updated_at = datetime('now') WHERE currency = ? AND is_default = 1",
        [input.currency],
      );
    return save("bank_accounts", input, id);
  })();
}
export function saveContact(input: ContactInput, id?: string): Contact {
  if (id) getBankingRecord("contacts", id);
  if (input.bank_id) {
    const bank = getBankingRecord("banks", input.bank_id);
    if (bank.archived && !input.archived)
      throw new HttpError(400, "Choose an active bank", undefined, "VALIDATION_FAILED");
  }
  return save("contacts", input, id);
}
export function defaultAccount(currency: string): string | null {
  return (
    (
      getDb()
        .query(
          "SELECT id FROM bank_accounts WHERE currency = ? AND is_default = 1 AND archived = 0",
        )
        .get(currency.toUpperCase()) as { id: string } | null
    )?.id ?? null
  );
}
export function validateInvoiceAccount(id: string | null, currency: string): void {
  if (!id) return;
  const account = getBankingRecord("bank_accounts", id);
  if (
    account.archived ||
    getBankingRecord("banks", account.bank_id).archived ||
    account.currency !== currency.toUpperCase()
  ) {
    throw new HttpError(
      400,
      "Select an active bank account matching the invoice currency",
      undefined,
      "VALIDATION_FAILED",
    );
  }
}
export function invoicePaymentDetails(invoiceId: string): PaymentDetails {
  const invoice = getDb()
    .query("SELECT bank_account_id, bank_snapshot, currency FROM invoices WHERE id = ?")
    .get(invoiceId) as {
    bank_account_id: string | null;
    bank_snapshot: string | null;
    currency: string;
  };
  if (!invoice) throw new HttpError(404, "Invoice not found", undefined, "NOT_FOUND");
  if (invoice.bank_snapshot !== null)
    return {
      bank_name: "",
      holder: "",
      currency: invoice.currency,
      account_number: "",
      iban: "",
      bic: "",
      bank_details: "",
      ...JSON.parse(invoice.bank_snapshot),
    } as PaymentDetails;
  if (invoice.bank_account_id) {
    const a = getBankingRecord("bank_accounts", invoice.bank_account_id);
    return {
      bank_id: a.bank_id,
      bank_name: a.bank_name,
      holder: a.holder,
      currency: a.currency,
      account_number: a.account_number,
      iban: a.iban,
      bic: a.bic,
      bank_details: [
        a.bank_name,
        a.holder,
        a.account_number && `RIB / Account: ${a.account_number}`,
        a.iban && `IBAN: ${a.iban}`,
        a.bic && `BIC / SWIFT: ${a.bic}`,
        a.instructions,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  const s = getAllSettings();
  return {
    bank_name: "",
    holder: s.company_account_holder || s.company_name || "",
    currency: invoice.currency,
    account_number: "",
    iban: s.company_iban || "",
    bic: s.company_bic || "",
    bank_details: s.company_bank_details || "",
  };
}
export function freezeInvoiceBank(invoiceId: string): void {
  const invoice = getDb()
    .query("SELECT bank_account_id, currency FROM invoices WHERE id = ?")
    .get(invoiceId) as { bank_account_id: string | null; currency: string };
  validateInvoiceAccount(invoice.bank_account_id, invoice.currency);
  getDb().run("UPDATE invoices SET bank_snapshot = COALESCE(bank_snapshot, ?) WHERE id = ?", [
    JSON.stringify(invoicePaymentDetails(invoiceId)),
    invoiceId,
  ]);
}
export function invoiceBankSettings(
  invoiceId: string,
  settings: Record<string, string>,
): Record<string, string> {
  const details = invoicePaymentDetails(invoiceId);
  return {
    ...settings,
    company_bank_details: details.bank_details || "",
    company_iban: details.iban || "",
    company_bic: details.bic || "",
    company_account_holder: details.holder || "",
  };
}
