import { lookup as dnsLookup } from "node:dns/promises";

/**
 * Egress guard for chatflow `http` nodes.
 *
 * Split out of engine.ts because this is the only thing standing between a
 * user-authored URL and a server-side fetch: chatflow graphs are written by
 * persona owners (any registered user — see the PUT graph route in
 * apps/api/src/routes.ts), and the http node's response body is fed back into
 * the flow's vars, so an unguarded fetch is a *readable* SSRF primitive, not a
 * blind one. Worth unit-testing on its own.
 *
 * The old guard compared the hostname against a handful of literal strings
 * ("localhost", "127.0.0.1", "0.0.0.0", "*.local"). That is sound only while an
 * exact-match allowlist does the real work. Once CHATFLOW_HTTP_ALLOWLIST is
 * opened up with `*`, this file becomes the barrier, so it checks address
 * ranges instead of spellings — 169.254.169.254 and 100.100.100.200 are the
 * addresses that actually matter and neither is a string the old list caught.
 */

/**
 * Allowlist entry meaning "any public host". Cannot collide with a real
 * hostname: `*` is not a legal DNS label, and WHATWG URL parsing rejects it in
 * an authority, so no reachable host can ever equal this sentinel.
 */
export const ALLOW_ANY_HOST = "*";

/**
 * Suffixes that never resolve to anything public. `.internal` covers GCP's
 * metadata.google.internal; `.local` is mDNS; the rest are conventional
 * intranet suffixes that are not delegated TLDs.
 */
const INTERNAL_SUFFIXES = [
  ".local",
  ".localhost",
  ".internal",
  ".home.arpa",
  ".lan",
  ".intranet",
  ".corp",
  ".private",
  // Kubernetes service DNS (kubernetes.default.svc, svc.cluster.local).
  ".svc",
];

/**
 * Metadata endpoints that answer on a *public-looking* name, so neither the IP
 * ranges nor the internal suffixes catch them. Tencent's is the one that
 * matters here — this deployment is China-facing, and metadata.tencentyun.com
 * hands out CVM role credentials with no token step.
 */
const METADATA_HOSTS = new Set([
  "metadata.tencentyun.com",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

/**
 * Lowercase, unbracket, and drop the trailing dot.
 *
 * All three matter: WHATWG returns IPv6 hosts wrapped in brackets
 * (`new URL("http://[::1]/").hostname === "[::1]"`), and "evil.local." is the
 * same name to DNS but not to endsWith(".local").
 */
export function normalizeHost(raw: string): string {
  let h = (raw ?? "").trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/**
 * Re-run a bare hostname through WHATWG URL parsing.
 *
 * This is what collapses the classic alternate IPv4 encodings — 2130706433,
 * 0x7f.0.0.1, 0177.1 all normalise to dotted-quad 127.x — so the range checks
 * below only ever have to understand one form. Reusing the platform parser
 * beats hand-rolling inet_aton. Returns null when the host is unparseable,
 * which callers must treat as "block".
 */
function canonicalizeHost(host: string): string | null {
  if (!host) return null;
  try {
    const probe = new URL(`http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}/`);
    return normalizeHost(probe.hostname);
  } catch {
    return null;
  }
}

/** Dotted-quad only — the sole IPv4 form WHATWG URL emits. */
function parseIpv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return parts.some((n) => n > 255) ? null : parts;
}

/** Returns 16 bytes, expanding `::` and any embedded IPv4 tail. */
function parseIpv6(host: string): number[] | null {
  if (!host.includes(":")) return null;
  // A zone id has no business in a URL; refuse rather than guess.
  if (host.includes("%")) return null;

  const halves = host.split("::");
  if (halves.length > 2) return null;

  const toGroups = (s: string): number[] | null => {
    if (!s) return [];
    const out: number[] = [];
    for (const part of s.split(":")) {
      if (part === "") return null;
      if (part.includes(".")) {
        const v4 = parseIpv4(part);
        if (!v4) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };

  const head = toGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if (!head || !tail) return null;

  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
  return bytes;
}

/**
 * Non-public IPv4 space. Ordered roughly by how likely each is to be the thing
 * an attacker actually wants.
 */
function ipv4Reason(b: number[]): string | null {
  const [a, c] = [b[0]!, b[1]!];
  if (a === 127) return "loopback";
  if (a === 10) return "private range 10/8";
  if (a === 172 && c >= 16 && c <= 31) return "private range 172.16/12";
  if (a === 192 && c === 168) return "private range 192.168/16";
  // 169.254.169.254 (AWS/Azure IMDS, GCP by IP) lives here.
  if (a === 169 && c === 254) return "link-local / cloud metadata";
  // 100.64/10 is CGNAT and also holds Alibaba Cloud's 100.100.100.200.
  if (a === 100 && c >= 64 && c <= 127) return "carrier-grade NAT / cloud metadata";
  if (a === 0) return "unspecified range 0/8";
  if (a === 192 && c === 0) return "IETF reserved 192.0/16";
  if (a === 198 && (c === 18 || c === 19)) return "benchmarking range";
  if (a >= 224) return "multicast / reserved";
  return null;
}

function ipv6Reason(b: number[]): string | null {
  const zeros = (upTo: number) => b.slice(0, upTo).every((x) => x === 0);

  // ::ffff:a.b.c.d — judge the embedded IPv4, or ::ffff:7f00:1 slips through.
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff) {
    return ipv4Reason(b.slice(12)) ?? null;
  }
  // NAT64 well-known prefix 64:ff9b::/96 also embeds IPv4.
  if (
    b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b &&
    b.slice(4, 12).every((x) => x === 0)
  ) {
    return ipv4Reason(b.slice(12)) ?? null;
  }
  if (zeros(12)) {
    const last = b.slice(12);
    if (last.every((x) => x === 0)) return "unspecified address";
    if (last[0] === 0 && last[1] === 0 && last[2] === 0 && last[3] === 1) {
      return "loopback";
    }
    // IPv4-compatible ::a.b.c.d
    return ipv4Reason(last) ?? null;
  }
  if ((b[0]! & 0xfe) === 0xfc) return "unique-local fc00::/7";
  // All of fe00::/8, not just fe80::/10: the old `(b[1] & 0xc0) === 0x80` mask
  // matched fe80-febf only, letting site-local fec0::/10 and the unassigned
  // fe00-fe7f block straight through. None of fe00::/8 is globally routable.
  if (b[0] === 0xfe) return "link-local / site-local fe00::/8";
  if (b[0] === 0xff) return "multicast ff00::/8";
  // Default-deny anything outside global unicast 2000::/3. Every publicly
  // routable IPv6 address lives there, so this closes the whole long tail of
  // reserved and special-purpose prefixes without enumerating them.
  if ((b[0]! & 0xe0) !== 0x20) return "outside global unicast 2000::/3";
  return null;
}

/**
 * Range verdict for one already-literal address, v4 or v6.
 *
 * Shared by the lexical check and the post-resolution check so both judge
 * addresses by exactly the same rules.
 */
export function ipReason(addr: string): string | null {
  const host = normalizeHost(addr);
  const v4 = parseIpv4(host);
  if (v4) return ipv4Reason(v4);
  const v6 = parseIpv6(host);
  if (v6) return ipv6Reason(v6);
  return null;
}

/**
 * Why this host must not be fetched, or null when it looks publicly routable.
 *
 * Lexical only, and deliberately so: it stays synchronous and cheap, and it
 * refuses every *direct* attempt at loopback, RFC1918 and the metadata
 * endpoints in each encoding the URL parser can produce. Names that merely
 * resolve somewhere internal are not its job — pair it with
 * blockedResolvedReason, which does the looking.
 */
export function blockedHostReason(rawHost: string): string | null {
  const host = canonicalizeHost(normalizeHost(rawHost));
  if (!host) return "unparseable host";

  const v4 = parseIpv4(host);
  if (v4) return ipv4Reason(v4);

  const v6 = parseIpv6(host);
  if (v6) return ipv6Reason(v6);

  if (host === "localhost") return "loopback";
  if (METADATA_HOSTS.has(host)) return "cloud metadata hostname";
  // A public name needs a dot. Single labels are Docker service names, bare
  // intranet hostnames, and "metadata" — never anything routable.
  if (!host.includes(".")) return "single-label / intranet hostname";
  for (const suffix of INTERNAL_SUFFIXES) {
    if (host.endsWith(suffix)) return `internal suffix ${suffix}`;
  }
  return null;
}

/**
 * Resolve the name and judge what it actually points at.
 *
 * The lexical pass above cannot see through DNS, and that is where the real
 * evasions live: `169-254-169-254.nip.io` is a perfectly ordinary `.io` name
 * that resolves to the IMDS address, an attacker's own A record can point at
 * 10.0.0.5, and Docker's embedded DNS answers `service.network` with a bridge
 * address. All three are lexically indistinguishable from a public host, so the
 * only way to refuse them is to look.
 *
 * A resolution failure is deliberately NOT an error: if the name does not
 * resolve here it will not resolve for fetch either, so nothing can egress, and
 * turning transient DNS trouble into a hard `http_blocked` would abort the whole
 * flow over a blip.
 *
 * Residual gap: this resolves, then fetch resolves again, so an attacker who
 * controls authoritative DNS with a very short TTL can still rebind between the
 * two lookups. Closing that needs the socket pinned to the address that was
 * actually validated — an undici Agent with a custom `connect.lookup`, which
 * means taking on undici as a dependency. Documented in docs/chatflow.md.
 */
export async function blockedResolvedReason(
  rawHost: string,
  resolve: HostResolver = defaultResolver,
): Promise<string | null> {
  const host = canonicalizeHost(normalizeHost(rawHost));
  if (!host) return "unparseable host";
  // Literals were already judged directly; resolving them adds nothing.
  if (parseIpv4(host) || parseIpv6(host)) return null;

  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return null;
  }

  for (const address of addresses) {
    const reason = ipReason(address);
    if (reason) return `${host} resolves to ${address} (${reason})`;
  }
  return null;
}

/**
 * Injectable so the range logic can be tested without a network. Real DNS in a
 * test would measure the resolver, not the code — some sandboxes answer every
 * query with a placeholder address.
 */
export type HostResolver = (host: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (host) => {
  const found = await dnsLookup(host, { all: true, verbatim: true });
  return found.map((f) => f.address);
};

/** True when the allowlist entries opt into "any public host". */
export function allowsAnyHost(entries: readonly string[] | undefined): boolean {
  return (entries ?? []).some((e) => e.trim() === ALLOW_ANY_HOST);
}
