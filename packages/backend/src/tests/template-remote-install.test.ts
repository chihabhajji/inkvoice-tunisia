// Installing a template from a URL fetches the manifest, then whatever URLs
// that manifest names, and stores the HTML where the installer can read it
// back. So every one of those reads must stay on public addresses, through
// redirects too, or the install is a way to read internal endpoints.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { installFromUrl, updateFromManifest } from "../services/template.service";
import { resetEnvCache } from "../utils/env";
import { setAddressResolver } from "../utils/ssrf-protection";

const TEST_DB = "./data/test-template-remote-install.db";
const NOT_ALLOWED = "address not allowed (public https URLs only)";

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];

/** Serves `routes` by URL, following redirects unless told not to, as the
 *  real fetch does. Anything unlisted answers 404. */
function serve(routes: Record<string, () => Response>) {
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    fetchCalls.push(url);
    const res = routes[url]?.() ?? new Response("not found", { status: 404 });
    const location = res.headers.get("location");
    if (location && init?.redirect !== "manual") {
      return fakeFetch(new URL(location, url).toString(), init);
    }
    return res;
  };
  globalThis.fetch = fakeFetch as typeof fetch;
}

const json = (body: unknown) => () => Response.json(body);
const text = (body: string) => () => new Response(body);
const redirect = (location: string) => () =>
  new Response(null, { status: 302, headers: { location } });

const MANIFEST = "https://templates.test/manifest.json";
const HTML = "https://templates.test/template.html";
const CSS = "https://templates.test/style.css";
const METADATA = "http://169.254.169.254/latest/meta-data/iam/security-credentials/role";

function templateCount(): number {
  return (getDb().query("SELECT COUNT(*) AS n FROM templates").get() as { n: number }).n;
}

beforeAll(() => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "testpass123";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  resetEnvCache();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
  initDatabase();
  runMigrations();
  setAddressResolver(
    async (hostname) =>
      ({ "internal.test": ["10.0.0.5"], "nowhere.test": [] })[hostname] ?? ["93.184.216.34"],
  );
});

afterEach(() => {
  globalThis.fetch = realFetch;
  fetchCalls = [];
});

afterAll(() => {
  setAddressResolver(null);
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

describe("installFromUrl", () => {
  test("installs from public URLs, following a redirect between them", async () => {
    serve({
      "https://short.test/t": redirect(MANIFEST),
      [MANIFEST]: json({ name: "Remote", html_url: HTML, css_url: CSS }),
      [HTML]: text("<div>{{invoice_number}}</div>"),
      [CSS]: text("div { color: red }"),
    });

    const template = await installFromUrl("https://short.test/t");
    expect(template.name).toBe("Remote");
    expect(template.html_content).toContain("{{invoice_number}}");
    expect(template.css_content).toBe("div { color: red }");
    expect(fetchCalls).toEqual(["https://short.test/t", MANIFEST, HTML, CSS]);
  });

  test("a manifest URL that redirects to the metadata service is never followed", async () => {
    serve({
      "https://evil.test/m.json": redirect(METADATA),
      [METADATA]: text("AccessKeyId=AKIA-METADATA"),
    });
    const before = templateCount();

    await expect(installFromUrl("https://evil.test/m.json")).rejects.toThrow(
      `Failed to fetch manifest: ${NOT_ALLOWED}`,
    );
    expect(fetchCalls).toEqual(["https://evil.test/m.json"]);
    expect(templateCount()).toBe(before);
  });

  test("an html_url that redirects inward is never followed", async () => {
    serve({
      [MANIFEST]: json({ name: "Exfil", html_url: "https://evil.test/r" }),
      "https://evil.test/r": redirect("https://internal.test/admin"),
      "https://internal.test/admin": text("<p>internal dashboard</p>"),
    });
    const before = templateCount();

    await expect(installFromUrl(MANIFEST)).rejects.toThrow(
      `Failed to fetch template HTML: ${NOT_ALLOWED}`,
    );
    expect(fetchCalls).toEqual([MANIFEST, "https://evil.test/r"]);
    expect(templateCount()).toBe(before);
  });

  test("private, unresolvable and plain http addresses all fail the same way, unrequested", async () => {
    for (const url of [
      "https://internal.test/m.json",
      "https://nowhere.test/m.json",
      "https://10.0.0.5/m.json",
      "http://templates.test/m.json",
    ]) {
      serve({});
      await expect(installFromUrl(url)).rejects.toThrow(`Failed to fetch manifest: ${NOT_ALLOWED}`);
      expect(fetchCalls).toEqual([]);
    }
  });

  test("a stylesheet that answers 404 is skipped, one that redirects inward is not", async () => {
    serve({
      [MANIFEST]: json({ name: "No CSS", html_url: HTML, css_url: CSS }),
      [HTML]: text("<div></div>"),
    });
    expect((await installFromUrl(MANIFEST)).css_content).toBeNull();

    serve({
      [MANIFEST]: json({ name: "Sneaky CSS", html_url: HTML, css_url: "https://evil.test/c" }),
      [HTML]: text("<div></div>"),
      "https://evil.test/c": redirect(METADATA),
    });
    await expect(installFromUrl(MANIFEST)).rejects.toThrow(
      `Failed to fetch stylesheet: ${NOT_ALLOWED}`,
    );
    expect(fetchCalls).not.toContain(METADATA);
  });

  test("refuses to buffer an unbounded body", async () => {
    serve({
      [MANIFEST]: json({ name: "Huge", html_url: HTML }),
      [HTML]: text("x".repeat(2 * 1024 * 1024)),
    });
    await expect(installFromUrl(MANIFEST)).rejects.toThrow(
      "Failed to fetch template HTML: response too large",
    );
  });
});

describe("updateFromManifest", () => {
  test("re-checks the stored manifest URL and what it now points at", async () => {
    serve({
      [MANIFEST]: json({ name: "Updatable", html_url: HTML }),
      [HTML]: text("<div>v1</div>"),
    });
    const template = await installFromUrl(MANIFEST);

    serve({
      [MANIFEST]: json({ html_url: "https://evil.test/r" }),
      "https://evil.test/r": redirect(METADATA),
      [METADATA]: text("AccessKeyId=AKIA-METADATA"),
    });
    await expect(updateFromManifest(template.id)).rejects.toThrow(
      `Failed to fetch template: ${NOT_ALLOWED}`,
    );
    expect(fetchCalls).not.toContain(METADATA);

    const stored = getDb()
      .query("SELECT html_content FROM templates WHERE id = ?")
      .get(template.id) as { html_content: string };
    expect(stored.html_content).toContain("v1");
  });
});
