import { isIP } from 'node:net';
import { Sensitivity } from '../constants/sensitivity';
import { MaskSessionContext, fakeValueFor } from './fake-value.util';

const HOST_KEYS =
  /^(host|hostname|fqdn|domain|zone|zonename|publicurl|url|apiurl|endpoint|address|masterhost)$/i;
const PERSON_KEYS =
  /^(email|useremail|owneremail|adminemail|username|displayname|fullname|firstname|lastname)$/i;
const MAX_DEPTH = 12;

function isEmail(value: string): boolean {
  if (/\s/.test(value)) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  const dot = domain.indexOf('.', 1);
  return local.length > 0 && dot > 0 && dot < domain.length - 1;
}

function sensitivityOf(key: string, value: string): Sensitivity | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isEmail(trimmed) || PERSON_KEYS.test(key)) {
    return Sensitivity.TENANT_IDENTITY;
  }
  const [address, prefix, extra] = trimmed.split('/');
  if (
    extra === undefined &&
    isIP(address) &&
    (!prefix || /^\d{1,3}$/.test(prefix))
  ) {
    return Sensitivity.NETWORK_IDENTIFIER;
  }
  if (HOST_KEYS.test(key) && /[a-z0-9-]\.[a-z]/i.test(trimmed)) {
    return Sensitivity.NETWORK_IDENTIFIER;
  }
  return null;
}

/**
 * Mask mode for a response with no declared type: nothing says which fields
 * are sensitive, so they are recognised by shape (an email, an IP address or
 * range anywhere) and by name (host-like and person-like keys). Weaker than a
 * declared DTO, but a screen shared with the switch on no longer shows the
 * real values of the responses nobody classified yet.
 */
export function maskUntyped(
  value: unknown,
  session: MaskSessionContext,
  saltSecret: string,
  key = '',
  depth = 0,
): unknown {
  if (value == null || depth > MAX_DEPTH) return value;
  if (typeof value === 'string') {
    const sensitivity = sensitivityOf(key, value);
    return sensitivity === Sensitivity.TENANT_IDENTITY ||
      sensitivity === Sensitivity.NETWORK_IDENTIFIER
      ? fakeValueFor(sensitivity, value, session, saltSecret)
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((el) =>
      maskUntyped(el, session, saltSecret, key, depth + 1),
    );
  }
  if (typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskUntyped(v, session, saltSecret, k, depth + 1);
    }
    return out;
  }
  return value;
}
