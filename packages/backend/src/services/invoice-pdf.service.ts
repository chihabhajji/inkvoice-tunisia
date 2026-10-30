import { existsSync } from "node:fs";
import { type Browser, chromium } from "playwright-core";
import { HttpError } from "../utils/http-error";
import { renderInvoiceHtml } from "./pdf.service";

let browserPromise: Promise<Browser> | null = null;
async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const executablePath =
      process.env.CHROMIUM_EXECUTABLE_PATH ||
      [
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ].find(existsSync);
    browserPromise = chromium
      .launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
      .then((browser) => {
        browser.on("disconnected", () => {
          browserPromise = null;
        });
        return browser;
      })
      .catch((error) => {
        browserPromise = null;
        throw error;
      });
  }
  return browserPromise;
}
export async function invoicePdf(invoiceId: string): Promise<Buffer> {
  const html = renderInvoiceHtml(invoiceId);
  if (!html) throw new HttpError(404, "Invoice template not found", undefined, "NOT_FOUND");
  const browser = await getBrowser();
  const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
  try {
    // Templates are user-controlled: PDF rendering must not fetch internal or external URLs.
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; frame-src 'none'">`;
    await page.setContent(csp + html, { waitUntil: "load", timeout: 30000 });
    return await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
  } finally {
    await context.close();
  }
}
export async function closeInvoicePdfBrowser(): Promise<void> {
  if (browserPromise) await (await browserPromise).close();
  browserPromise = null;
}
