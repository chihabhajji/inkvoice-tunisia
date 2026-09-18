import { roundMoney } from "./money";
/**
 * Early-payment (cash) discount helpers.
 *
 * An invoice can offer a discount for paying within `cash_discount_days` of the
 * issue date. The discount reduces the amount the customer needs to pay; the
 * given-up amount is recorded on the invoice (`cash_discount_applied`) and the
 * invoice settles as paid once received + applied discounts equal the total.
 */

export type CashDiscountType = "percentage" | "amount";

/** Adds `days` days (UTC) to an ISO `YYYY-MM-DD` date. */
export function addDays(from: string, days: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface CashDiscountConfig {
  type?: string | null;
  value?: number;
  days?: number;
}

/** A cash discount is offered only when days > 0 and a positive value is set. */
export function hasCashDiscount(config: CashDiscountConfig): boolean {
  return (config.days ?? 0) > 0 && (config.value ?? 0) > 0;
}

/**
 * The monetary discount for paying `amount` (a positive balance) early.
 * - percentage: round2(amount * value / 100)
 * - amount: min(value, amount)
 */
export function cashDiscountOn(
  amount: number,
  config: Required<CashDiscountConfig>,
  currency?: string,
): number {
  const round = (n: number) => roundMoney(n, currency);
  if (!hasCashDiscount(config) || amount <= 0) return 0;
  const value = config.value;
  const discounted = config.type === "amount" ? value : round((amount * value) / 100);
  return Math.min(round(discounted), amount);
}

/** Date (ISO) the cash discount expires for an invoice issued on `issueDate`. */
export function cashDiscountDeadline(issueDate: string, days: number): string {
  return addDays(issueDate, days);
}

/** Whether the discount is still claimable on `paymentDate`. */
export function isWithinCashDiscountWindow(
  issueDate: string,
  paymentDate: string,
  days: number,
): boolean {
  return paymentDate <= cashDiscountDeadline(issueDate, days);
}
