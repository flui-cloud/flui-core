import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import {
  alwaysBlockedReason,
  blockedReason,
  EgressPolicy,
  egressPolicyFromEnv,
  isAllowedHost,
} from '../../../common/net/egress-guard';
import { AlertSeverityFloor } from '../entities/alert-destination.entity';

const SEVERITY_RANK: Record<string, number> = { warning: 1, critical: 2 };

/** Anything below a warning, or a severity nobody declared, is delivered nowhere. */
export function meetsFloor(
  severity: string | null | undefined,
  floor: AlertSeverityFloor,
): boolean {
  const rank = SEVERITY_RANK[(severity ?? '').toLowerCase()] ?? 0;
  return rank > 0 && rank >= SEVERITY_RANK[floor];
}

/** `sha256=<hex>` over `<timestamp>.<body>`, the value of `X-Flui-Signature`. */
export function signAlertWebhook(
  secret: string,
  timestamp: number,
  body: string,
): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `sha256=${digest}`;
}

const INTERNAL_NAME = /(^|\.)(localhost|local|internal|svc|cluster\.local)$/i;

export type ResolveAll = (hostname: string) => Promise<string[]>;

export const resolveAll: ResolveAll = async (hostname) =>
  (await dns.lookup(hostname, { all: true })).map((a) => a.address);

/**
 * Refuses, at creation, a webhook address that would have the installation
 * post into its own network. Delivery goes through the egress guard as well,
 * so a name that later resolves somewhere private is still refused then.
 *
 * A receiver inside the installation is reached only through a host named in
 * `FLUI_EGRESS_ALLOWED_HOSTS`, and only such a host may be spoken to over plain
 * http. Link-local stays refused even then: that is where cloud metadata lives.
 */
export async function assertWebhookTarget(
  raw: string,
  policy: EgressPolicy = egressPolicyFromEnv(),
  resolve: ResolveAll = resolveAll,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('The webhook address is not a valid URL');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const allowed = isAllowedHost(host, policy);
  const schemes = allowed ? ['https:', 'http:'] : ['https:'];
  if (!schemes.includes(url.protocol)) {
    throw new BadRequestException(
      'The webhook address must use https (plain http only to a host named in FLUI_EGRESS_ALLOWED_HOSTS)',
    );
  }
  if (url.username || url.password) {
    throw new BadRequestException(
      'Put no credentials in the webhook address: every delivery is signed instead',
    );
  }
  if (!allowed && INTERNAL_NAME.test(host)) {
    throw new BadRequestException(
      `${host} is a name inside this installation's own network`,
    );
  }

  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await resolve(host);
    } catch {
      throw new BadRequestException(`${host} does not resolve`);
    }
  }
  const judge = allowed ? alwaysBlockedReason : blockedReason;
  for (const address of addresses) {
    const reason = judge(address);
    if (reason) {
      throw new BadRequestException(
        `${host} points at ${reason}, inside this installation's own network`,
      );
    }
  }
  return url;
}
