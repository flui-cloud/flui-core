import { isIPv4 } from 'node:net';

/**
 * Whether a name is published on every nameserver of its zone with the
 * address Flui wrote, and what to record while it is not. A certificate asked
 * for before then makes the ACME check fail on a name that does not exist
 * yet, and a resolver may keep that answer cached.
 */

export const DEFERRAL_LIMIT_MS = 60 * 60 * 1000;

export interface AuthoritativeAnswer {
  nameserver: string;
  /** Null when the server said the name does not exist, or did not answer. */
  addresses: string[] | null;
  /** The name exists with no A record (a CNAME, say): nothing to cache as missing. */
  noData?: boolean;
}

export interface PublicationVerdict {
  published: boolean;
  /** Why it is not published, naming the nameservers; null once it is. */
  detail: string | null;
}

export function publicationVerdict(
  fqdn: string,
  expected: string,
  answers: AuthoritativeAnswer[],
): PublicationVerdict {
  const missing: string[] = [];
  const wrong: string[] = [];
  // A CNAME or IPv6 value never comes back from an A query as itself.
  const matchAddress = isIPv4(expected);
  for (const a of answers) {
    if (a.noData) continue;
    if (a.addresses === null || a.addresses.length === 0) {
      missing.push(a.nameserver);
    } else if (matchAddress && !a.addresses.includes(expected)) {
      wrong.push(`${a.addresses.join(', ')} on ${a.nameserver}`);
    }
  }
  if (!missing.length && !wrong.length)
    return { published: true, detail: null };

  const parts: string[] = [];
  if (missing.length) {
    parts.push(`${fqdn} is not published yet on ${missing.join(', ')}.`);
  }
  if (wrong.length) {
    parts.push(`${fqdn} answers ${wrong.join('; ')}, not ${expected}.`);
  }
  return { published: false, detail: parts.join(' ') };
}

export interface DeferredCertificate {
  status: 'pending' | 'failed';
  since: Date;
  message: string;
}

export function deferredCertificate(
  since: Date | null,
  now: Date,
  detail: string,
): DeferredCertificate {
  const start = since ?? now;
  if (now.getTime() - start.getTime() >= DEFERRAL_LIMIT_MS) {
    return {
      status: 'failed',
      since: start,
      message: `Still not published after an hour: ${detail} Check the record at the DNS provider, then Sync.`,
    };
  }
  return {
    status: 'pending',
    since: start,
    message: `Waiting for the name to be published: ${detail} The certificate is requested as soon as every nameserver of the zone answers; this usually takes minutes, at most an hour.`,
  };
}
