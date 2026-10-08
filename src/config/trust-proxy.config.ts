/**
 * Which hops in front of the API may say who the client is.
 *
 * Every request reaches the API through the ingress, so without this Express
 * reports the ingress as the client and every per-address limit becomes one
 * limit shared by the whole internet. Only private and loopback hops are
 * trusted by default: the ingress and the node are, a visitor never is, so a
 * forged `X-Forwarded-For` cannot name somebody else.
 */
export const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';

export type TrustProxySetting = boolean | number | string;

export function trustProxySetting(
  raw: string | undefined = process.env.TRUST_PROXY,
): TrustProxySetting {
  const value = raw?.trim();
  let setting: TrustProxySetting = DEFAULT_TRUST_PROXY;
  if (value === 'false') setting = false;
  else if (value && /^\d+$/.test(value)) setting = Number(value);
  else if (value) setting = value;
  return setting;
}
