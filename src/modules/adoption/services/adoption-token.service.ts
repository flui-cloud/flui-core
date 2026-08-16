import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'node:crypto';

export interface AdoptionTokenPayload {
  /** Where this installation answers, so the CLI does not have to be told. */
  endpoint: string;
  clusterId: string;
  /** Unix seconds. */
  expiresAt: number;
  /** Token id, so a token can be spent exactly once. */
  jti: string;
}

export interface AdoptionVerdict {
  valid: boolean;
  payload?: AdoptionTokenPayload;
  reason?: string;
}

const PREFIX = 'flui_adopt';
export const ADOPTION_TOKEN_TTL_SECONDS = 3600;

/**
 * Issues and checks the one-time token that lets a cluster's owner adopt it.
 *
 * Adoption is the moment an installation agrees to trust a certificate
 * authority it has never seen, generated on a machine it has never met. The
 * token is the only thing standing between that and anyone who can reach the
 * endpoint, which is why it is short-lived, single-use, and bound to this
 * installation rather than being a bearer string that works anywhere.
 *
 * Signed, not stored. Verification needs no lookup, so a token cannot be
 * validated against a table that a restore or a failover left behind; what is
 * recorded is only the opposite — which tokens have already been spent.
 *
 * The signing key is derived from the installation's JWT secret through HKDF
 * with its own label. Reusing the secret directly would make an adoption token
 * and a session token interchangeable to anything that checks a signature and
 * not its purpose.
 */
@Injectable()
export class AdoptionTokenService {
  private readonly logger = new Logger(AdoptionTokenService.name);

  constructor(private readonly configService: ConfigService) {}

  issue(input: { clusterId: string; endpoint: string }): {
    token: string;
    expiresAt: Date;
  } {
    const expiresAt =
      Math.floor(Date.now() / 1000) + ADOPTION_TOKEN_TTL_SECONDS;
    const payload: AdoptionTokenPayload = {
      endpoint: input.endpoint,
      clusterId: input.clusterId,
      expiresAt,
      jti: crypto.randomBytes(16).toString('hex'),
    };

    const body = encode(JSON.stringify(payload));
    const signature = encode(this.sign(body));
    return {
      token: `${PREFIX}_${body}.${signature}`,
      expiresAt: new Date(expiresAt * 1000),
    };
  }

  verify(token: string, spentJtis: readonly string[] = []): AdoptionVerdict {
    if (!token?.startsWith(`${PREFIX}_`)) {
      return { valid: false, reason: 'Not an adoption token.' };
    }

    const [body, signature] = token.slice(PREFIX.length + 1).split('.');
    if (!body || !signature) {
      return { valid: false, reason: 'Malformed adoption token.' };
    }

    const expected = this.sign(body);
    const presented = decodeRaw(signature);
    // Constant-time, and length-guarded first: timingSafeEqual throws on a
    // length mismatch, and a thrown error is itself an oracle.
    if (
      presented.length !== expected.length ||
      !crypto.timingSafeEqual(presented, expected)
    ) {
      return {
        valid: false,
        reason: 'Adoption token signature does not match.',
      };
    }

    let payload: AdoptionTokenPayload;
    try {
      payload = JSON.parse(decodeRaw(body).toString('utf-8'));
    } catch {
      return { valid: false, reason: 'Malformed adoption token.' };
    }

    if (payload.expiresAt * 1000 < Date.now()) {
      return {
        valid: false,
        reason:
          'This adoption token has expired. Issue a new one from the dashboard.',
      };
    }

    if (spentJtis.includes(payload.jti)) {
      return {
        valid: false,
        reason: 'This adoption token has already been used.',
      };
    }

    return { valid: true, payload };
  }

  /** Reads the endpoint without checking anything — for error messages only. */
  peekEndpoint(token: string): string | null {
    try {
      const body = token.slice(PREFIX.length + 1).split('.')[0];
      return (
        JSON.parse(decodeRaw(body).toString('utf-8')) as AdoptionTokenPayload
      ).endpoint;
    } catch {
      return null;
    }
  }

  private sign(body: string): Buffer {
    return crypto.createHmac('sha256', this.signingKey()).update(body).digest();
  }

  private signingKey(): Buffer {
    const secret = this.configService.get<string>('JWT_SECRET');
    if (!secret) {
      // Refusing is the right failure: an unsigned or predictably-signed token
      // would let anyone who can reach this endpoint enrol their own CA.
      throw new Error(
        'Cannot issue or verify adoption tokens: JWT_SECRET is not set on this installation.',
      );
    }
    return Buffer.from(
      crypto.hkdfSync(
        'sha256',
        Buffer.from(secret),
        Buffer.alloc(0),
        'flui-adoption-token-v1',
        32,
      ),
    );
  }
}

function encode(value: string | Buffer): string {
  return Buffer.from(value as never).toString('base64url');
}

function decodeRaw(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}
