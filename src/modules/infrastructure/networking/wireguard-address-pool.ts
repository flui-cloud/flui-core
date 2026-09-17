import { BadRequestException } from '@nestjs/common';

export interface Ipv4Cidr {
  /** Network address as an unsigned 32-bit integer. */
  base: number;
  prefix: number;
}

/** k3s pod and service ranges. A management address inside either would be
 *  shadowed by the cluster's own routes on every node. */
export const CLUSTER_RESERVED_CIDRS = ['10.42.0.0/16', '10.43.0.0/16'];

export const DEFAULT_MANAGEMENT_POOL = '10.250.0.0/16';

const IPV4_CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * An IPv6 range, which for every question this module answers is not a wrong
 * answer but an irrelevant one: it cannot overlap an IPv4 pool and cannot
 * contain an IPv4 address, so comparing the two is meaningless rather than
 * mistaken. Matched on the colon, which no IPv4 CIDR carries — deliberately
 * narrow, so a mistyped IPv4 range still fails loudly instead of being skipped.
 *
 * This exists because a provider handed us one: a Scaleway private network is
 * dual-stack, so its subnets arrive as an IPv4 range *and* an fd00::/8 range,
 * and every range Flui knows about is fed to the pool as something to avoid.
 */
function isIpv6Cidr(cidr: string): boolean {
  return cidr.includes(':');
}

/** Only the ranges an IPv4 pool can meaningfully be compared against. */
export function ipv4CidrsOnly(
  cidrs: readonly (string | null | undefined)[],
): string[] {
  return cidrs.filter((c): c is string => !!c && !isIpv6Cidr(c));
}

export function parseCidr(cidr: string): Ipv4Cidr {
  const m = IPV4_CIDR_RE.exec(cidr.trim());
  if (!m) throw new BadRequestException(`Not an IPv4 CIDR: "${cidr}"`);
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 32) {
    throw new BadRequestException(`Not an IPv4 CIDR: "${cidr}"`);
  }
  const addr = toInt(octets);
  return { base: addr & maskOf(prefix), prefix };
}

export function parseIp(ip: string): number {
  const m = IPV4_RE.exec(ip.trim());
  if (!m) throw new BadRequestException(`Not an IPv4 address: "${ip}"`);
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  if (octets.some((o) => o > 255)) {
    throw new BadRequestException(`Not an IPv4 address: "${ip}"`);
  }
  return toInt(octets);
}

export function formatIp(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

export function cidrsOverlap(a: string, b: string): boolean {
  const x = parseCidr(a);
  const y = parseCidr(b);
  const shared = maskOf(Math.min(x.prefix, y.prefix));
  return (x.base & shared) === (y.base & shared);
}

/**
 * The next free block of `prefix` bits inside `network`.
 *
 * Deliberately not `SubnetCalculator.calculateNextSubnetRange`, which does the
 * same arithmetic through an ESM-only dependency Jest cannot parse — every spec
 * that touches it has to mock the module away, which is a poor trade for twenty
 * lines of shifts.
 *
 * Blocks are handed out lowest-first and a released one is reused: unlike a
 * peer address, a subnet carries no identity a stale config elsewhere could
 * still name, so there is nothing to protect by burning it.
 */
export function nextFreeBlock(
  network: string,
  taken: string[],
  prefix: number,
): string | null {
  const net = parseCidr(network);
  if (prefix < net.prefix || prefix > 32) {
    throw new BadRequestException(
      `A /${prefix} does not fit inside ${network}`,
    );
  }
  const used = new Set(
    ipv4CidrsOnly(taken)
      .map((t) => parseCidr(t))
      .filter((t) => (t.base & maskOf(net.prefix)) === net.base)
      .map((t) => t.base & maskOf(prefix)),
  );
  // A /0 is the whole address space: one candidate, and a step of zero would
  // walk the loop below forever.
  if (prefix === 0) return used.has(0) ? null : `${formatIp(0)}/0`;

  const step = (~maskOf(prefix) >>> 0) + 1;
  const last = (net.base | (~maskOf(net.prefix) >>> 0)) >>> 0;
  for (let base = net.base; base <= last; base += step) {
    if (!used.has(base)) return `${formatIp(base)}/${prefix}`;
    if (base + step > last) break;
  }
  return null;
}

/**
 * Whether an address falls inside a range.
 *
 * Deliberately not `SubnetCalculator`, which pulls in an ESM-only dependency:
 * this is four lines of arithmetic, and the callers that need it run inside
 * cluster creation where a broken import graph would be expensive.
 */
export function cidrContains(cidr: string, ip: string): boolean {
  const range = parseCidr(cidr);
  return (parseIp(ip) & maskOf(range.prefix)) === range.base;
}

/**
 * Allocates management addresses out of one pool.
 *
 * Sequential and boring by design. A management overlay is not a subnet users
 * design around — nobody reads these addresses except the operator chasing a
 * tunnel — so the only properties that matter are that an address is never
 * handed out twice and never silently shadows a route the node already has.
 *
 * The pool is checked against the cluster's own pod and service ranges and
 * against every private network Flui knows about, and allocation is refused on
 * overlap rather than working until the day a packet quietly takes the wrong
 * route.
 */
export class WireGuardAddressPool {
  private readonly cidr: Ipv4Cidr;

  constructor(
    private readonly pool: string = DEFAULT_MANAGEMENT_POOL,
    knownCidrs: string[] = [],
  ) {
    this.cidr = parseCidr(pool);
    if (this.cidr.prefix > 30) {
      throw new BadRequestException(
        `Management pool ${pool} is too small to hold any peer`,
      );
    }
    const clash = ipv4CidrsOnly([
      ...CLUSTER_RESERVED_CIDRS,
      ...knownCidrs,
    ]).find((known) => cidrsOverlap(pool, known));
    if (clash) {
      throw new BadRequestException(
        `Management pool ${pool} overlaps ${clash}. Pick a range that no ` +
          `cluster or private network already uses, or the overlay will ` +
          `shadow routes the nodes already have.`,
      );
    }
  }

  get range(): string {
    return this.pool;
  }

  contains(ip: string): boolean {
    return (parseIp(ip) & maskOf(this.cidr.prefix)) === this.cidr.base;
  }

  /**
   * Lowest free address in the pool.
   *
   * `taken` is the current allocation as the database knows it; addresses
   * outside the pool are ignored rather than rejected, so narrowing the pool
   * does not break allocation for peers that predate the change.
   */
  allocate(taken: Iterable<string>): string {
    const used = new Set<number>();
    for (const ip of taken) {
      const value = parseIp(ip);
      if ((value & maskOf(this.cidr.prefix)) === this.cidr.base) {
        used.add(value);
      }
    }
    const first = this.cidr.base + 1;
    const last = this.broadcast() - 1;
    for (let candidate = first; candidate <= last; candidate++) {
      if (!used.has(candidate)) return formatIp(candidate);
    }
    throw new BadRequestException(
      `Management pool ${this.pool} is exhausted (${used.size} addresses in use)`,
    );
  }

  private broadcast(): number {
    return (this.cidr.base | (~maskOf(this.cidr.prefix) >>> 0)) >>> 0;
  }
}

function maskOf(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

function toInt(octets: number[]): number {
  return (
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  );
}
