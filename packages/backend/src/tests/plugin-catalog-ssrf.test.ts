// The catalog URL is a settings value, and in a multi-tenant overlay the party
// who can write settings is a customer rather than the operator. So the fetch
// it drives is treated as attacker-influenced: these tests pin the guard, not
// the happy path (that lives in plugin-catalog-service.test.ts).

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDatabase, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { getCatalog } from "../plugins/catalog.service";
import { updateSettings } from "../services/settings.service";
import { resetEnvCache } from "../utils/env";
import { SafeFetchError, safeFetchJson } from "../utils/safe-fetch";
import { setAddressResolver, validateUrl } from "../utils/ssrf-protection";

const TEST_DB = "./data/test-plugin-catalog-ssrf.db";

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];

function stubFetch(impl: (url: string) => Promise<Response>) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push(url);
    return impl(url);
  }) as typeof fetch;
}

/** Public unless the hostname says otherwise, so a test can make exactly one
 *  host resolve inward. */
function resolverFor(map: Record<string, string[]>) {
  return async (hostname: string) => map[hostname] ?? ["93.184.216.34"];
}

/** The suite's baseline: every .test hostname resolves to a public address, so
 *  a test that reaches DNS is exercising the rule it names rather than the fact
 *  that its fixture domain does not exist. */
const publicResolver = resolverFor({});

beforeAll(() => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "testpass123";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  resetEnvCache();
  initDatabase();
  runMigrations();
  setAddressResolver(publicResolver);
});

afterAll(() => {
  setAddressResolver(null);
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {
      // best effort
    }
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setAddressResolver(publicResolver);
  fetchCalls = [];
});

describe("validateUrl", () => {
  test("rejects a bare private IPv4 literal without consulting DNS", async () => {
    setAddressResolver(async () => {
      throw new Error("resolver must not be called for a literal");
    });
    // The pre-hardening version reached DNS here, failed to resolve an address
    // that is already an address, and allowed the URL through.
    await expect(validateUrl("https://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /private\/internal/,
    );
  });

  test("rejects IPv6 unique-local and link-local literals", async () => {
    await expect(validateUrl("https://[fd00::1]/")).rejects.toThrow(/private\/internal/);
    await expect(validateUrl("https://[fe80::1]/")).rejects.toThrow(/private\/internal/);
  });

  test("rejects an IPv4-mapped IPv6 literal that lands in a private range", async () => {
    await expect(validateUrl("https://[::ffff:10.0.0.5]/")).rejects.toThrow(/private\/internal/);
  });

  test("rejects carrier-grade NAT space", async () => {
    await expect(validateUrl("https://[::ffff:100.64.0.1]/")).rejects.toThrow(/private\/internal/);
  });

  test("rejects http", async () => {
    await expect(validateUrl("http://example.com/")).rejects.toThrow(/HTTPS/);
  });

  test("allowUnresolvable false fails closed on an unresolvable host", async () => {
    setAddressResolver(async () => []);
    await expect(
      validateUrl("https://nope.invalid/", { allowUnresolvable: false }),
    ).rejects.toThrow(/could not be resolved/);
    // The default stays permissive; everything that fetches passes false.
    await expect(validateUrl("https://nope.invalid/")).resolves.toBeUndefined();
  });
});

describe("safeFetchJson", () => {
  test("re-validates every redirect hop", async () => {
    setAddressResolver(resolverFor({ "internal.test": ["10.0.0.5"] }));
    stubFetch((url) =>
      url.includes("start.test")
        ? Promise.resolve(
            new Response(null, { status: 302, headers: { location: "https://internal.test/x" } }),
          )
        : Promise.resolve(new Response("{}", { status: 200 })),
    );

    const err = (await safeFetchJson("https://start.test/catalog.json").catch(
      (e: unknown) => e,
    )) as SafeFetchError;
    expect(err).toBeInstanceOf(SafeFetchError);
    expect(err.code).toBe("blocked");
    // It stopped at the redirect: the inward hop was never requested.
    expect(fetchCalls).toEqual(["https://start.test/catalog.json"]);
  });

  test("refuses to buffer a body past the cap", async () => {
    stubFetch(() => Promise.resolve(new Response("x".repeat(200), { status: 200 })));
    const err = (await safeFetchJson("https://big.test/catalog.json", { maxBytes: 100 }).catch(
      (e: unknown) => e,
    )) as SafeFetchError;
    expect(err.code).toBe("too_large");
  });

  test("refuses a body whose declared length is already over the cap", async () => {
    stubFetch(() =>
      Promise.resolve(
        new Response("{}", { status: 200, headers: { "content-length": "99999999" } }),
      ),
    );
    const err = (await safeFetchJson("https://big.test/catalog.json", { maxBytes: 100 }).catch(
      (e: unknown) => e,
    )) as SafeFetchError;
    expect(err.code).toBe("too_large");
  });

  test("does not follow a redirect for POST", async () => {
    stubFetch(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }),
      ),
    );
    const err = (await safeFetchJson("https://vote.test/", { method: "POST", body: "{}" }).catch(
      (e: unknown) => e,
    )) as SafeFetchError;
    expect(err.code).toBe("http_error");
    expect(fetchCalls).toHaveLength(1);
  });
});

describe("getCatalog with a hostile catalog url", () => {
  test("a url resolving into a private range never opens a socket", async () => {
    updateSettings({
      plugin_catalog_url: "https://evil.test/catalog.v1.json",
      plugin_catalog_cache: "",
      plugin_catalog_synced_at: "",
    });
    setAddressResolver(resolverFor({ "evil.test": ["169.254.169.254"] }));
    stubFetch(() => {
      throw new Error("fetch must not be reached");
    });

    const res = await getCatalog();
    expect(fetchCalls).toEqual([]);
    expect(res.source).toBe("snapshot");
    expect(res.error).toBe("blocked");
  });
});
