import { HttpError } from "./http-error";
import { logger } from "./logger";

function getLocaleForNumberFormat(numberFormat?: string): string {
  switch (numberFormat) {
    case "1.000,00":
      return "de-DE";
    case "1 000,00":
      return "fr-FR";
    case "1,000.00":
    default:
      return "en-US";
  }
}

// Documents predating the currency dropdown can carry a half-typed code like
// "EU", which Intl rejects. Render the amount with the code appended rather
// than throwing, and log it so the bad data is discoverable.
function formatFallback(amount: number, currency: string, locale: string): string {
  let formatted: string;
  try {
    formatted = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    formatted = amount.toFixed(2);
  }
  return `${formatted} ${currency}`.trim();
}

export function formatCurrency(
  amount: number,
  currency = "USD",
  numberFormat?: string,
  localeOverride?: string,
): string {
  const locale = localeOverride || getLocaleForNumberFormat(numberFormat);
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount);
  } catch (err) {
    logger.warn({ currency, locale, err }, "Falling back on unformattable currency");
    return formatFallback(amount, currency, locale);
  }
}

export function requireTwoDecimalCurrency(currency: string, integration: string): void {
  if (currency.toUpperCase() === "TND") {
    throw new HttpError(
      400,
      `${integration} does not support TND millimes. Use a standard invoice/PDF and record payment manually.`,
      undefined,
      "VALIDATION_FAILED",
    );
  }
}
