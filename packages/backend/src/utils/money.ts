/** TND uses millimes; retain upstream precision for other currencies. */
export function moneyDecimals(currency = "USD"): number {
  return currency.toUpperCase() === "TND" ? 3 : 2;
}

export function minorUnits(amount: number, currency = "USD"): number {
  const scale = 10 ** moneyDecimals(currency);
  return Math.round(amount * scale);
}

export function roundMoney(amount: number, currency = "USD"): number {
  return minorUnits(amount, currency) / 10 ** moneyDecimals(currency);
}
