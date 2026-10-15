/**
 * IP allowlist / CIDR matching (`docs/audits/security-1.md` M7 — the
 * `X-Forwarded-For` client key is spoofable, so an allowlist gate must do its
 * own arithmetic instead of string-prefix checks).
 *
 * Pure and dependency-free (no `node:net`): parse/validate a CIDR block,
 * normalize an address literal, probe its IP version, test containment and
 * evaluate a deny-by-default "any of these blocks" gate. True IPv4 plus basic
 * IPv6 — no embedded IPv4 (`::ffff:1.2.3.4`) and no zone ids.
 */

/** One parsed CIDR block. `first`/`last` are the inclusive address bounds. */
export type Cidr = {
  /** The input address, canonicalized (host bits preserved). */
  address: string;
  version: 4 | 6;
  /** Prefix length: 0-32 for IPv4, 0-128 for IPv6. */
  prefix: number;
  /** Lowest address in the block (the network address). */
  first: string;
  /** Highest address in the block (broadcast / last address). */
  last: string;
};

export type CidrParseResult =
  | { ok: true; value: Cidr }
  | { ok: false; error: string };

const GROUPS_PER_IPV6 = 8;
const BITS_PER_GROUP = BigInt(16);
const BITS_PER_OCTET = BigInt(8);
const IPV4_BITS = BigInt(32);
const IPV6_BITS = BigInt(128);
const V4_MAX_PREFIX = 32;
const V6_MAX_PREFIX = 128;
const MASK8 = BigInt(0xff);
const MASK16 = BigInt(0xffff);

const OCTET_RE = /^\d{1,3}$/;
const HEXTET_RE = /^[0-9a-fA-F]{1,4}$/;
const PREFIX_RE = /^\d{1,3}$/;

function isHextet(part: string): boolean {
  return HEXTET_RE.test(part);
}

/** Parse a dotted-quad IPv4 literal to its 32-bit unsigned value. */
function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = BigInt(0);
  for (const part of parts) {
    if (!OCTET_RE.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << BITS_PER_OCTET) | BigInt(octet);
  }
  return value;
}

/** Parse an IPv6 literal to its 128-bit unsigned value (no embedded IPv4). */
function ipv6ToBigInt(ip: string): bigint | null {
  const doubleColons = ip.split("::").length - 1;
  if (doubleColons > 1) return null;

  let groups: string[];
  if (doubleColons === 1) {
    const [head, tail] = ip.split("::");
    const headParts = head === "" ? [] : head.split(":");
    const tailParts = tail === "" ? [] : tail.split(":");
    if (!headParts.every(isHextet) || !tailParts.every(isHextet)) return null;
    const missing = GROUPS_PER_IPV6 - headParts.length - tailParts.length;
    // "::" must stand for at least one 16-bit group.
    if (missing < 1) return null;
    const filler = Array.from({ length: missing }, () => "0");
    groups = [...headParts, ...filler, ...tailParts];
  } else {
    groups = ip.split(":");
    if (groups.length !== GROUPS_PER_IPV6 || !groups.every(isHextet)) return null;
  }

  let value = BigInt(0);
  for (const group of groups) {
    value = (value << BITS_PER_GROUP) | BigInt(parseInt(group, 16));
  }
  return value;
}

/** Render a 32-bit value as dotted-decimal IPv4. */
function formatIpv4(value: bigint): string {
  const octets: number[] = [];
  for (let shift = 24; shift >= 0; shift -= 8) {
    octets.push(Number((value >> BigInt(shift)) & MASK8));
  }
  return octets.join(".");
}

/** Render a 128-bit value as RFC 5952-canonical lowercase IPv6. */
function formatIpv6(value: bigint): string {
  const hextets: number[] = [];
  for (let index = 0; index < GROUPS_PER_IPV6; index += 1) {
    const shift = BigInt((GROUPS_PER_IPV6 - 1 - index) * 16);
    hextets.push(Number((value >> shift) & MASK16));
  }

  // Compress the longest run (length >= 2) of zero groups; leftmost wins ties.
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  let runLength = 0;
  for (let index = 0; index < GROUPS_PER_IPV6; index += 1) {
    if (hextets[index] === 0) {
      if (runStart < 0) runStart = index;
      runLength += 1;
      if (runLength > bestLength) {
        bestStart = runStart;
        bestLength = runLength;
      }
    } else {
      runStart = -1;
      runLength = 0;
    }
  }
  if (bestLength < 2) bestStart = -1;

  const parts = hextets.map((hextet) => hextet.toString(16));
  if (bestStart < 0) return parts.join(":");
  const left = parts.slice(0, bestStart).join(":");
  const right = parts.slice(bestStart + bestLength).join(":");
  return `${left}::${right}`;
}

function ipToBigInt(ip: string, version: 4 | 6): bigint | null {
  return version === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip);
}

/** The IP family of `ip` (`4`, `6`), or `null` when it is not an IP literal. */
export function ipVersion(ip: string): 4 | 6 | null {
  if (typeof ip !== "string") return null;
  const text = ip.trim();
  if (ipv4ToBigInt(text) !== null) return 4;
  if (ipv6ToBigInt(text) !== null) return 6;
  return null;
}

/**
 * Canonicalize an address literal: IPv4 to dotted-decimal without leading
 * zeros, IPv6 to RFC 5952 (lowercase, zero-compressed). Returns `null` for
 * anything that is not a valid IPv4/IPv6 literal.
 */
export function normalizeIp(ip: string): string | null {
  if (typeof ip !== "string") return null;
  const text = ip.trim();
  const v4 = ipv4ToBigInt(text);
  if (v4 !== null) return formatIpv4(v4);
  const v6 = ipv6ToBigInt(text);
  if (v6 !== null) return formatIpv6(v6);
  return null;
}

/**
 * Parse a CIDR block (`"10.0.0.0/8"`, `"2001:db8::/64"`) or a bare address
 * (treated as a single host: `/32` or `/128`). Host bits are masked off the
 * network address, and `first`/`last` describe the inclusive range. Invalid
 * input is reported, never thrown.
 */
export function parseCidr(raw: string): CidrParseResult {
  if (typeof raw !== "string") {
    return { ok: false, error: "Expected a CIDR string." };
  }
  const text = raw.trim();
  if (text === "") return { ok: false, error: "Expected a CIDR string." };

  const slash = text.indexOf("/");
  let addressText = text;
  let prefixText: string | null = null;
  if (slash >= 0) {
    if (text.indexOf("/", slash + 1) >= 0) {
      return { ok: false, error: `Too many "/" separators in "${raw}".` };
    }
    addressText = text.slice(0, slash).trim();
    prefixText = text.slice(slash + 1).trim();
  }

  const v4 = ipv4ToBigInt(addressText);
  const v6 = v4 === null ? ipv6ToBigInt(addressText) : null;

  let version: 4 | 6;
  let value: bigint;
  if (v4 !== null) {
    version = 4;
    value = v4;
  } else if (v6 !== null) {
    version = 6;
    value = v6;
  } else {
    return { ok: false, error: `"${addressText}" is not a valid IPv4 or IPv6 address.` };
  }

  const maxPrefix = version === 4 ? V4_MAX_PREFIX : V6_MAX_PREFIX;
  let prefix: number;
  if (prefixText === null) {
    prefix = maxPrefix;
  } else {
    if (!PREFIX_RE.test(prefixText)) {
      return { ok: false, error: `Prefix "${prefixText}" must be a number between 0 and ${maxPrefix}.` };
    }
    prefix = Number(prefixText);
    if (prefix > maxPrefix) {
      return { ok: false, error: `Prefix ${prefix} is out of range for IPv${version} (0-${maxPrefix}).` };
    }
  }

  const bits = version === 4 ? IPV4_BITS : IPV6_BITS;
  const hostBits = bits - BigInt(prefix);
  const network = (value >> hostBits) << hostBits;
  const last = network | ((BigInt(1) << hostBits) - BigInt(1));
  const format = version === 4 ? formatIpv4 : formatIpv6;

  return {
    ok: true,
    value: {
      address: format(value),
      version,
      prefix,
      first: format(network),
      last: format(last),
    },
  };
}

/** True when `raw` is a well-formed CIDR block or bare address literal. */
export function validateCidr(raw: unknown): boolean {
  return typeof raw === "string" && parseCidr(raw).ok;
}

/**
 * True when `ip` falls inside `cidr` (inclusive of both bounds). Accepts a
 * raw CIDR string or an already-parsed {@link Cidr}, and fails closed —
 * malformed input, a version mismatch or an invalid block → `false`.
 */
export function ipInCidr(ip: string, cidr: string | Cidr): boolean {
  const parsed =
    typeof cidr === "string" ? parseCidr(cidr) : { ok: true as const, value: cidr };
  if (!parsed.ok) return false;
  const block = parsed.value;

  const version = ipVersion(ip);
  if (version === null || version !== block.version) return false;

  const text = ip.trim();
  const value = ipToBigInt(text, version);
  const first = ipToBigInt(block.first, version);
  const last = ipToBigInt(block.last, version);
  if (value === null || first === null || last === null) return false;
  return value >= first && value <= last;
}

/**
 * Deny-by-default allowlist gate: true when `ip` matches at least one of
 * `cidrs`. Malformed entries are ignored; an empty list matches nothing.
 */
export function matchAny(ip: string, cidrs: readonly (string | Cidr)[]): boolean {
  return cidrs.some((cidr) => ipInCidr(ip, cidr));
}
