// Outbound fetch for URLs an untrusted party can configure. validateUrl
// alone is not enough for those: a bare fetch() follows redirects internally,
// so a public URL that answers 302 -> http://169.254.169.254/ would sail past
// a check performed only on the URL that was typed. Redirects are therefore
// followed by hand here, re-validating every hop, and the body is read against
// a byte budget so a hostile endpoint cannot stream unbounded data into memory.
//
// Errors carry a coarse machine code as well as a message. Callers that show
// anything to a non-operator must surface only the code (publicFetchError
// does that): the exact message distinguishes "connection refused" from
// "HTTP 403" from "not JSON", which is a usable oracle for mapping an internal
// network from the outside.

import { validateUrl } from "./ssrf-protection";

export type SafeFetchErrorCode =
  | "blocked"
  | "unreachable"
  | "http_error"
  | "too_large"
  | "invalid_json";

export class SafeFetchError extends Error {
  constructor(
    public readonly code: SafeFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  /** Body budget for safeFetchText and safeFetchJson. */
  maxBytes?: number;
  maxRedirects?: number;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
}

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Fetch `url`, validating it and every redirect hop before connecting. Only
 * GET is redirect-followed: 301/302/303 rewrite a POST to GET, which would
 * silently turn a vote into a read against an attacker's endpoint, so any
 * other method gets its 3xx back unfollowed. Resolves with the final response
 * and its body unread; read it with readBody so a byte budget applies. The
 * timeout keeps running while the body is read.
 */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const { timeoutMs = 5_000, maxRedirects = 3, method = "GET", body, headers = {} } = opts;

  let current = url;
  for (let hop = 0; ; hop++) {
    try {
      await validateUrl(current, { allowUnresolvable: false });
    } catch (err) {
      throw new SafeFetchError("blocked", (err as Error).message);
    }

    let res: Response;
    try {
      res = await fetch(current, {
        method,
        body,
        // Manual, so the hop below is validated before it is followed.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers,
      });
    } catch (err) {
      throw new SafeFetchError("unreachable", (err as Error).message || "fetch failed");
    }

    if (res.status < 300 || res.status >= 400 || method !== "GET") return res;

    if (hop >= maxRedirects) throw new SafeFetchError("blocked", "too many redirects");
    const location = res.headers.get("location");
    if (!location) throw new SafeFetchError("http_error", `HTTP ${res.status} without Location`);
    try {
      current = new URL(location, current).toString();
    } catch {
      throw new SafeFetchError("blocked", "malformed redirect target");
    }
  }
}

/** safeFetch, failing on any status outside 2xx, then the body as text. */
export async function safeFetchText(url: string, opts: SafeFetchOptions = {}): Promise<string> {
  const res = await safeFetch(url, opts);
  if (!res.ok) throw new SafeFetchError("http_error", `HTTP ${res.status}`);
  return readBody(res, opts.maxBytes ?? DEFAULT_MAX_BYTES);
}

export async function safeFetchJson(url: string, opts: SafeFetchOptions = {}): Promise<unknown> {
  const text = await safeFetchText(url, {
    ...opts,
    headers: { Accept: "application/json", ...opts.headers },
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new SafeFetchError("invalid_json", "response was not JSON");
  }
}

/** Read the body, refusing to buffer more than maxBytes. Checks the declared
 *  length first as a cheap rejection, then enforces the real budget while
 *  streaming, because Content-Length can lie or be absent. With `truncate`,
 *  keeps the first maxBytes instead of refusing. */
export async function readBody(
  res: Response,
  maxBytes: number,
  { truncate = false }: { truncate?: boolean } = {},
): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (!truncate && Number.isFinite(declared) && declared > maxBytes) {
    throw new SafeFetchError("too_large", `declared ${declared} bytes, limit ${maxBytes}`);
  }

  const reader = res.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      await reader.cancel().catch(() => {});
      if (!truncate) throw new SafeFetchError("too_large", `exceeded ${maxBytes} bytes`);
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      break;
    }
    total += value.byteLength;
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** What to tell whoever configured the URL: the coarse reason, never the
 *  detail (see the header), which belongs in the operator's log. Anything
 *  that is not a SafeFetchError, such as a connection dropped while the body
 *  was being read, counts as unreachable. */
export function publicFetchError(err: unknown): string {
  if (!(err instanceof SafeFetchError)) return "could not connect";
  switch (err.code) {
    case "blocked":
      return "address not allowed (public https URLs only)";
    case "unreachable":
      return "could not connect";
    case "http_error":
      // Every hop was validated before it was requested, so the status came
      // from a public host.
      return err.message;
    case "too_large":
      return "response too large";
    case "invalid_json":
      return "response is not valid JSON";
  }
}
