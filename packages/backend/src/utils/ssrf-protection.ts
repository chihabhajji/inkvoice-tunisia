import { resolve4, resolve6 } from "node:dns/promises";

/** Resolves a hostname to the addresses a connection to it could reach.
 *  Injectable so a deployment can point at its own resolver, and so tests can
 *  exercise the private-range rules without depending on live DNS. */
export type AddressResolver = (hostname: string) => Promise<string[]>;

async function systemResolver(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    resolve4(hostname).catch(() => [] as string[]),
    resolve6(hostname).catch(() => [] as string[]),
  ]);
  return [...v4, ...v6];
}

let addressResolver: AddressResolver = systemResolver;

/** Pass null to restore the system resolver. */
export function setAddressResolver(fn: AddressResolver | null): void {
  addressResolver = fn ?? systemResolver;
}

export interface ValidateUrlOptions {
  /**
   * When DNS cannot resolve the host, allow it anyway. Pass false for any URL
   * this server goes on to fetch (safeFetch does): a name this resolver cannot
   * see, such as an /etc/hosts entry, may still connect somewhere internal.
   */
  allowUnresolvable?: boolean;
}

/**
 * Validate a URL for safe fetching — rejects non-HTTPS and private/internal IPs.
 */
export async function validateUrl(url: string, opts: ValidateUrlOptions = {}): Promise<void> {
  const { allowUnresolvable = true } = opts;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Only HTTPS URLs are allowed");
  }

  const hostname = parsed.hostname;

  // Block obvious localhost / loopback
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0.0.0.0"
  ) {
    throw new Error("URLs pointing to localhost are not allowed");
  }

  // A bare IP literal never reaches DNS, so check it directly. URL keeps IPv6
  // literals in brackets; strip them before parsing.
  const literal = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (isIpLiteral(literal)) {
    if (isPrivateIp(literal)) {
      throw new Error("URLs pointing to private/internal networks are not allowed");
    }
    return;
  }

  // Resolve DNS and check for private IP ranges
  const allIps = await addressResolver(hostname).catch(() => [] as string[]);

  if (allIps.length === 0) {
    if (allowUnresolvable) return;
    throw new Error("URL host could not be resolved");
  }

  for (const ip of allIps) {
    if (isPrivateIp(ip)) {
      throw new Error("URLs pointing to private/internal networks are not allowed");
    }
  }
}

function isIpLiteral(host: string): boolean {
  if (host.includes(":")) return true;
  const parts = host.split(".");
  return parts.length === 4 && parts.every((p) => p !== "" && /^\d+$/.test(p) && Number(p) <= 255);
}

function isPrivateIp(ip: string): boolean {
  const lower = ip.toLowerCase();

  if (lower.includes(":")) {
    // ::ffff:10.0.0.5 reaches 10.0.0.5, so the v4 rules below decide. Both
    // spellings must be unpacked: WHATWG URL parsing rewrites the dotted form
    // to hex (::ffff:a00:5), so matching only the readable one would leave the
    // shape that actually arrives from a URL unchecked.
    const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateIp(dotted[1]);
    const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = Number.parseInt(hex[1], 16);
      const lo = Number.parseInt(hex[2], 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }

    if (lower === "::1" || lower === "::") return true;
    // fc00::/7 unique local, fe80::/10 link local (fe80 through febf).
    if (/^f[cd]/.test(lower)) return true;
    if (/^fe[89ab]/.test(lower)) return true;
    return false;
  }

  const parts = lower.split(".").map(Number);
  if (parts.length === 4) {
    // 127.x.x.x (loopback)
    if (parts[0] === 127) return true;
    // 10.x.x.x (private)
    if (parts[0] === 10) return true;
    // 172.16.0.0 - 172.31.255.255 (private)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.x.x (private)
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 169.254.x.x (link-local, and so the cloud metadata endpoint)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 100.64.0.0/10 (carrier-grade NAT, routable inside many hosting networks)
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    // 0.0.0.0/8
    if (parts[0] === 0) return true;
  }

  return false;
}
