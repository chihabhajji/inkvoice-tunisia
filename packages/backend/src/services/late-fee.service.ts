import crypto from "node:crypto";
import { getDb } from "../database/connection";
import { todayIso, toIsoDate } from "../utils/date";
import { roundMoney } from "../utils/money";
import { calculateInvoiceTotals } from "../utils/tax-calculator";
import { logActivity } from "./activity.service";
import { getAllSettings } from "./settings.service";

interface EligibleInvoice {
  id: string;
  currency: string;
  total: number;
  discount_type: string | null;
  discount_value: number;
  prices_include_tax: number;
}

/**
 * Auto-apply late payment fees to overdue invoices past their grace period.
 *
 * Configured via settings:
 *   late_fee_enabled    "true" | "false"
 *   late_fee_type       "percentage" | "fixed"
 *   late_fee_value      number (percent [0-100] or flat amount)
 *   late_fee_grace_days number of days after due_date before a fee applies
 *   late_fee_frequency  "once" | "monthly"
 *
 * The fee is added as a non-taxable line item ("Late payment fee") and the
 * invoice totals are recomputed from its line items, so the balance due always
 * reflects it. "once" blocks further fees (`late_fee_blocked`); "monthly"
 * re-applies when `late_fee_next_date` is reached while still overdue.
 * Idempotent: safe to call on every list/view.
 */
export function applyLateFees(): number {
  const db = getDb();
  const s = getAllSettings();
  if (s.late_fee_enabled !== "true") return 0;

  const type = s.late_fee_type === "fixed" ? "fixed" : "percentage";
  const value = parseFloat(s.late_fee_value || "0");
  if (!Number.isFinite(value) || value <= 0) return 0;

  const graceDays = parseInt(s.late_fee_grace_days || "0", 10) || 0;
  const frequency = s.late_fee_frequency === "monthly" ? "monthly" : "once";

  const today = todayIso();
  const graceDate = new Date();
  graceDate.setDate(graceDate.getDate() - graceDays);
  const graceDateStr = toIsoDate(graceDate);

  const eligible = db
    .query(
      `SELECT id, currency, total, discount_type, discount_value, prices_include_tax
       FROM invoices
       WHERE status = 'overdue'
         AND deleted_at IS NULL
         AND due_date IS NOT NULL
         AND due_date <= ?
         AND late_fee_blocked = 0
         AND (late_fee_next_date IS NULL OR late_fee_next_date <= ?)`,
    )
    .all(graceDateStr, today) as EligibleInvoice[];

  let applied = 0;
  for (const inv of eligible) {
    const base = inv.total;
    const fee = roundMoney(type === "fixed" ? value : base * (value / 100), inv.currency);
    if (fee <= 0) continue;

    db.transaction(() => {
      const feeId = crypto.randomBytes(16).toString("hex");
      const maxSort = (
        db
          .query(
            "SELECT COALESCE(MAX(sort_order), -1) as m FROM invoice_items WHERE invoice_id = ?",
          )
          .get(inv.id) as { m: number }
      ).m;

      db.run(
        `INSERT INTO invoice_items (id, invoice_id, product_id, description, quantity, unit_price,
         unit, tax_id, tax_rate, tax_amount, line_total, sort_order)
         VALUES (?, ?, NULL, 'Late payment fee', 1, ?, 'piece', NULL, 0, 0, ?, ?)`,
        [feeId, inv.id, fee, fee, maxSort + 1],
      );

      const items = db
        .query("SELECT quantity, unit_price, tax_rate FROM invoice_items WHERE invoice_id = ?")
        .all(inv.id) as { quantity: number; unit_price: number; tax_rate: number }[];
      const totals = calculateInvoiceTotals(
        items.map((i) => ({
          quantity: i.quantity,
          unit_price: i.unit_price,
          tax_rate: i.tax_rate,
        })),
        inv.discount_type,
        inv.discount_value,
        { pricesIncludeTax: inv.prices_include_tax === 1, currency: inv.currency },
      );

      const nextDate = frequency === "monthly" ? addDaysIso(today, 30) : null;
      db.run(
        `UPDATE invoices
         SET subtotal = ?, tax_total = ?, discount_amount = ?, total = ?,
             late_fee_blocked = ?, late_fee_next_date = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [
          totals.subtotal,
          totals.tax_total,
          totals.discount_amount,
          totals.total,
          frequency === "once" ? 1 : 0,
          nextDate,
          inv.id,
        ],
      );

      logActivity({
        user_id: null,
        user_name: "System",
        action: "late_fee",
        resource_type: "invoice",
        resource_id: inv.id,
        metadata: { fee, frequency },
      });
    })();
    applied++;
  }

  return applied;
}

function addDaysIso(from: string, days: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}
