import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** What a share token authorizes: one object, until it expires. */
export interface ShareClaims {
  appId: string;
  bucket: string;
  key: string;
  /** Unix seconds. */
  exp: number;
}

const MAX_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

function b64urlEncode(buf: Buffer): string {
  // base64 padding is only ever trailing '='; strip it without a regex.
  return buf
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
}

/**
 * Signs and verifies object share links. The link is self-contained — the
 * recipient never needs a Flui session: the public proxy endpoint verifies the
 * HMAC + expiry and streams the object from the (cluster-internal) store through
 * the backend. The signing key is derived from JWT_SECRET with domain
 * separation so it can never be confused with an auth token.
 */
@Injectable()
export class ObjectStoreShareService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const base =
      config.get<string>('FLUI_OBJECT_SHARE_SECRET') ||
      config.get<string>('JWT_SECRET', 'changeme');
    this.key = createHmac('sha256', base)
      .update('flui-object-share-v1')
      .digest();
  }

  /** clampTtl → sign → "payload.sig". `nowSec` injected so callers stay testable. */
  sign(
    claims: Omit<ShareClaims, 'exp'>,
    ttlSeconds: number,
    nowSec: number,
  ): { token: string; expiresAt: string } {
    const ttl = Math.min(
      Math.max(Math.floor(ttlSeconds) || DEFAULT_TTL_SECONDS, 60),
      MAX_TTL_SECONDS,
    );
    const exp = nowSec + ttl;
    const payload: ShareClaims = { ...claims, exp };
    const encoded = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
    const sig = b64urlEncode(this.mac(encoded));
    return {
      token: `${encoded}.${sig}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /** Verify signature + expiry; throws BadRequest on any mismatch. */
  verify(token: string, nowSec: number): ShareClaims {
    const dot = token.indexOf('.');
    if (dot <= 0) throw new BadRequestException('Malformed share token');
    const encoded = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    const expected = this.mac(encoded);
    const got = b64urlDecode(sig);
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      throw new BadRequestException('Invalid share token');
    }

    let claims: ShareClaims;
    try {
      claims = JSON.parse(
        b64urlDecode(encoded).toString('utf8'),
      ) as ShareClaims;
    } catch {
      throw new BadRequestException('Malformed share token');
    }
    if (!claims.appId || !claims.bucket || !claims.key || !claims.exp) {
      throw new BadRequestException('Incomplete share token');
    }
    if (nowSec >= claims.exp) {
      throw new BadRequestException('Share link expired');
    }
    return claims;
  }

  private mac(encoded: string): Buffer {
    return createHmac('sha256', this.key).update(encoded).digest();
  }
}
