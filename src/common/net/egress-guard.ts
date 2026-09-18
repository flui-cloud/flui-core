import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import axios from 'axios';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';

/**
 * Where the installation is allowed to make an outbound request to.
 *
 * Several fields on this product are a URL somebody types: the base URL of an
 * inference provider, a heartbeat the operator points at their own watchdog, the
 * address the demo prober checks. Each of them is a request made *from inside
 * the cluster*, by a process that can reach the Kubernetes API, the node's
 * metadata service, Redis, Postgres and every workload on the network — so a URL
 * field is a read primitive against the private network unless something says
 * otherwise. This is that something.
 *
 * Three things make it work, and leaving any one out has been the classic way to
 * get this wrong:
 *
 *  - **The decision is made inside `lookup`, on the address about to be used.**
 *    Resolving first and connecting afterwards leaves a window in which DNS can
 *    change its mind (a rebind), and the connection then goes somewhere the
 *    check never saw. Deciding on the resolved address closes the window rather
 *    than narrowing it.
 *  - **Literal addresses never reach `lookup`.** Node connects straight to a
 *    host that is already an IP, so `http://127.0.0.1` would sail past a guard
 *    that only lives in the resolver. The hostname is vetted separately for that
 *    case. Obfuscated literals (`127.1`, `2130706433`) are *not* IPs to Node and
 *    do go through the resolver, where the resolved value is what is judged.
 *  - **Redirects are refused.** A 302 is a second request to a host nobody
 *    validated, and none of these callers has any business following one.
 *
 * The allow-list is by hostname and is an installation-level setting, never a
 * per-request one: on the inference path the caller is the threat, so a flag
 * they could send would be no guard at all. It exists because a self-hosted
 * installation may legitimately run a model server on the cluster or the LAN —
 * that is not supported today, and when it is, this is the door it comes through.
 */

const BLOCKED_V4 = [
  { label: 'this host', cidr: '0.0.0.0/8' },
  { label: 'loopback', cidr: '127.0.0.0/8' },
  { label: 'the private network', cidr: '10.0.0.0/8' },
  { label: 'the private network', cidr: '172.16.0.0/12' },
  { label: 'the private network', cidr: '192.168.0.0/16' },
  { label: 'carrier-grade NAT', cidr: '100.64.0.0/10' },
  {
    label: 'link-local (this is where cloud metadata lives)',
    cidr: '169.254.0.0/16',
  },
  { label: 'a benchmarking range', cidr: '198.18.0.0/15' },
  { label: 'multicast', cidr: '224.0.0.0/4' },
  { label: 'a reserved range', cidr: '240.0.0.0/4' },
] as const;

function v4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function inCidr(address: string, cidr: string): boolean {
  const [network, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const a = v4ToInt(address);
  const n = v4ToInt(network);
  if (a === null || n === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (n & mask);
}

/** Why this address is refused, or `null` if it is allowed. */
export function blockedReason(address: string): string | null {
  const family = isIP(address);

  if (family === 4) {
    const hit = BLOCKED_V4.find((r) => inCidr(address, r.cidr));
    return hit ? hit.label : null;
  }

  if (family === 6) {
    return blockedV6Reason(address);
  }

  return null;
}

/**
 * The eight 16-bit groups of an IPv6 address, or `null` if it cannot be read.
 *
 * Written out rather than matched with regexes on the text, because the same
 * address has many spellings and a regex sees only the one it was written for:
 * `::ffff:7f00:1` and `0:0:0:0:0:ffff:7f00:1` are the same host, and a check on
 * the compressed form alone lets the expanded one through.
 */
function v6Groups(address: string): number[] | null {
  const bare = address.toLowerCase().replace(/%.*$/, '');
  const [headText, tailText] = bare.split('::');
  if (bare.split('::').length > 2) return null;

  const parse = (text: string): number[] | null => {
    if (!text) return [];
    const out: number[] = [];
    for (const part of text.split(':')) {
      // A trailing dotted-quad, as in ::ffff:127.0.0.1
      if (part.includes('.')) {
        const n = v4ToInt(part);
        if (n === null) return null;
        out.push((n >>> 16) & 0xffff, n & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };

  const head = parse(headText ?? '');
  const tail = tailText === undefined ? [] : parse(tailText);
  if (head === null || tail === null) return null;

  if (tailText === undefined) return head.length === 8 ? head : null;

  const gap = 8 - head.length - tail.length;
  if (gap < 0) return null;
  return [...head, ...Array<number>(gap).fill(0), ...tail];
}

const v4Of = (hi: number, lo: number): string =>
  [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.');

function blockedV6Reason(address: string): string | null {
  const g = v6Groups(address);
  if (!g) return null;

  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);

  // Every way an IPv4 address can wear an IPv6 coat and still reach the same
  // host. Each is judged as the v4 address it carries, so one blocklist covers
  // all of them.
  if (zeroTo(5) && g[5] === 0xffff) return blockedReason(v4Of(g[6], g[7]));
  if (zeroTo(4) && g[4] === 0xffff && g[5] === 0) {
    return blockedReason(v4Of(g[6], g[7]));
  }
  if (zeroTo(6) && !(g[6] === 0 && g[7] === 0) && !(g[6] === 0 && g[7] === 1)) {
    // ::a.b.c.d — deprecated, but still an address a stack may route.
    return blockedReason(v4Of(g[6], g[7]));
  }
  // NAT64: on a cluster with a NAT64 gateway this reaches the embedded v4.
  if (g[0] === 0x0064 && g[1] === 0xff9b) {
    return blockedReason(v4Of(g[6], g[7]));
  }
  // 6to4 carries the v4 address in the two groups after the prefix.
  if (g[0] === 0x2002) return blockedReason(v4Of(g[1], g[2]));

  if (g.every((x) => x === 0)) return 'the unspecified address';
  if (zeroTo(7) && g[7] === 1) return 'loopback';
  if ((g[0] & 0xfe00) === 0xfc00) return 'a unique local address';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0] & 0xffc0) === 0xfec0) return 'a site-local address';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  return null;
}

export class EgressRefusedError extends Error {
  constructor(
    readonly host: string,
    readonly reason: string,
  ) {
    super(
      `Refusing to connect to ${host}: it resolves to ${reason}, which is inside this installation's own network.`,
    );
    this.name = 'EgressRefusedError';
  }
}

export interface EgressPolicy {
  /** Hostnames the installation has deliberately allowed, exactly as written. */
  allowedHosts?: string[];
}

function isAllowed(hostname: string, policy: EgressPolicy): boolean {
  const allowed = policy.allowedHosts ?? [];
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return allowed.some((h) => h.trim().toLowerCase() === host);
}

/**
 * Hostnames the installation allows through the guard, from the environment.
 *
 * Read here rather than taken from the request, and that is the whole point: on
 * the inference path any authenticated account can create a connection, so an
 * allow flag they could send would be the guard asking the attacker for
 * permission.
 */
export function egressPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EgressPolicy {
  const raw = env.FLUI_EGRESS_ALLOWED_HOSTS ?? '';
  return {
    allowedHosts: raw
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
  };
}

/**
 * Refuses a URL that cannot be reached safely, before any request is made.
 *
 * Catches the scheme and the literal-address case; a name still has to be
 * judged on what it resolves to, which is {@link guardedLookup}'s job.
 */
export function assertUrlAllowed(
  url: string,
  policy: EgressPolicy = egressPolicyFromEnv(),
): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EgressRefusedError(url, 'not a URL this can make sense of');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EgressRefusedError(
      parsed.hostname || url,
      `the scheme ${parsed.protocol} — only http and https are made from here`,
    );
  }

  if (isAllowed(parsed.hostname, policy)) return parsed;

  const literal = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal)) {
    const reason = blockedReason(literal);
    if (reason) throw new EgressRefusedError(parsed.hostname, reason);
  }

  return parsed;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

/**
 * The resolver the request actually uses, which refuses the address instead of
 * returning it.
 *
 * Passed to axios as `config.lookup`, so there is no moment between deciding and
 * connecting for the answer to change. Every address returned is judged, not
 * only the first: a name that resolves to one public address and one private one
 * is a rebind waiting to be noticed.
 */
export function guardedLookup(policy: EgressPolicy = egressPolicyFromEnv()) {
  return (
    hostname: string,
    options: unknown,
    callback: LookupCallback,
  ): void => {
    if (isAllowed(hostname, policy)) {
      dnsLookup(hostname, options as never, callback as never);
      return;
    }

    dnsLookup(
      hostname,
      options as never,
      ((
        err: NodeJS.ErrnoException | null,
        address: string | Array<{ address: string; family: number }>,
        family: number,
      ) => {
        if (err) return callback(err);

        const addresses = Array.isArray(address)
          ? address.map((a) => a.address)
          : [address];
        for (const candidate of addresses) {
          const reason = blockedReason(candidate);
          if (reason) {
            return callback(
              Object.assign(new EgressRefusedError(hostname, reason), {
                code: 'EGRESS_REFUSED',
              }) as NodeJS.ErrnoException,
            );
          }
        }
        callback(null, address, family);
      }) as never,
    );
  };
}

/**
 * The axios options every guarded outbound call carries.
 *
 * `maxRedirects: 0` is part of the guard, not a preference: axios only honours
 * `lookup` on the direct path, and a followed redirect is a request to a host
 * that was never judged.
 */
export function guardedRequestOptions(
  policy: EgressPolicy = egressPolicyFromEnv(),
): Pick<
  AxiosRequestConfig,
  'lookup' | 'maxRedirects' | 'httpAgent' | 'httpsAgent'
> {
  const lookup = guardedLookup(policy) as AxiosRequestConfig['lookup'];
  return {
    lookup,
    maxRedirects: 0,
    // Agents of our own, with keep-alive off, and this is load-bearing rather
    // than tidy.
    //
    // Node's global agent pools connections, and a pooled socket is reused
    // *without consulting any resolver* — the guard simply does not run. The
    // installation's own clients (Loki, Prometheus, Grafana) keep warm sockets
    // to fixed in-cluster hosts on a polling schedule, so a request aimed at one
    // of those host:port pairs could land on a socket that was already open and
    // read the internal service. It was reproduced, not theorised. A dedicated
    // agent that never keeps a socket means there is nothing to land on.
    httpAgent: new HttpAgent({ keepAlive: false }),
    httpsAgent: new HttpsAgent({ keepAlive: false }),
  };
}

/**
 * The way to make one of these requests. Prefer it to assembling the pieces.
 *
 * `guardedRequestOptions` alone is a trap: it installs the resolver, and Node
 * does not consult a resolver for a host that is already an address, so a caller
 * who only spreads the options is still reachable at `http://127.0.0.1`. This
 * asks both questions in the one place a caller has to remember.
 */
export async function guardedRequest<T = unknown>(
  config: AxiosRequestConfig & { url: string },
  policy: EgressPolicy = egressPolicyFromEnv(),
  /**
   * How many redirects to follow, each one validated again from scratch.
   *
   * Zero by default, because axios's own redirect following happens below the
   * layer where `lookup` applies — a followed redirect is a request to a host
   * nothing judged. Following them here instead means every hop goes through the
   * same two checks as the first, which is what lets a caller that genuinely
   * needs redirects (an edge answering :80 with a 301 to https) keep working.
   */
  maxGuardedRedirects = 0,
): Promise<AxiosResponse<T>> {
  let url = config.url;

  for (let hop = 0; ; hop++) {
    assertUrlAllowed(url, policy);
    const response = await axios.request<T>({
      ...config,
      url,
      ...guardedRequestOptions(policy),
      validateStatus:
        hop < maxGuardedRedirects
          ? (status) =>
              (status >= 300 && status < 400) ||
              (config.validateStatus?.(status) ??
                (status >= 200 && status < 300))
          : config.validateStatus,
    });

    const location =
      hop < maxGuardedRedirects &&
      response.status >= 300 &&
      response.status < 400
        ? (response.headers?.location as string | undefined)
        : undefined;
    if (!location) return response;

    url = new URL(location, url).toString();
  }
}
