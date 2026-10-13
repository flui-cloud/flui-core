import { createHmac, timingSafeEqual } from 'node:crypto';

export const IDENTITY_SIGNATURE_HEADER = 'zitadel-signature';

/** The identity provider's own default tolerance for a signed timestamp. */
export const IDENTITY_SIGNATURE_TOLERANCE_MS = 300_000;

export type SignatureVerdict =
  | 'valid'
  | 'missing'
  | 'malformed'
  | 'stale'
  | 'mismatch';

interface ParsedHeader {
  timestamp: number;
  signatures: Buffer[];
}

/**
 * Same grammar the identity provider writes and reads:
 * `t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>...]`.
 */
function parse(header: string): ParsedHeader | null {
  let timestamp: number | null = null;
  const signatures: Buffer[] = [];
  for (const pair of header.split(',')) {
    const parts = pair.split('=');
    if (parts.length !== 2) return null;
    const [name, value] = parts;
    if (name === 't') {
      if (!/^-?\d+$/.test(value)) return null;
      timestamp = Number(value);
    } else if (name === 'v1' && /^(?:[0-9a-f]{2})+$/i.test(value)) {
      signatures.push(Buffer.from(value, 'hex'));
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export function computeIdentitySignature(
  timestampSeconds: number,
  payload: string | Buffer,
  signingKey: string,
): Buffer {
  return createHmac('sha256', signingKey)
    .update(`${timestampSeconds}.`)
    .update(payload)
    .digest();
}

export function identitySignatureHeader(
  timestampSeconds: number,
  payload: string | Buffer,
  signingKey: string,
): string {
  const mac = computeIdentitySignature(timestampSeconds, payload, signingKey);
  return `t=${timestampSeconds},v1=${mac.toString('hex')}`;
}

/**
 * Checks the signature over the exact bytes that arrived. Stricter than the
 * identity provider's own check in one way: a timestamp too far in the future
 * is refused as well as one too far in the past.
 */
export function verifyIdentitySignature(
  header: string | undefined,
  payload: string | Buffer,
  signingKey: string,
  now: number = Date.now(),
  toleranceMs: number = IDENTITY_SIGNATURE_TOLERANCE_MS,
): SignatureVerdict {
  if (!header?.trim()) return 'missing';
  const parsed = parse(header.trim());
  if (!parsed) return 'malformed';
  if (Math.abs(now - parsed.timestamp * 1000) > toleranceMs) return 'stale';

  const expected = computeIdentitySignature(
    parsed.timestamp,
    payload,
    signingKey,
  );
  const match = parsed.signatures.some(
    (candidate) =>
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected),
  );
  return match ? 'valid' : 'mismatch';
}
