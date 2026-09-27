import { isIP } from 'node:net';
import { ValidationOptions, registerDecorator } from 'class-validator';

/**
 * An IPv4/IPv6 address or CIDR range the proxy will accept. A shape check is
 * not enough: the proxy discards the whole route when one entry is invalid.
 */
export function isGatewayCidr(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const parts = value.trim().split('/');
  if (parts.length > 2) return false;
  const family = isIP(parts[0]);
  if (!family) return false;
  if (parts.length === 1) return true;
  if (!/^\d{1,3}$/.test(parts[1])) return false;
  return Number(parts[1]) <= (family === 4 ? 32 : 128);
}

export function invalidGatewayCidrs(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((v) => !isGatewayCidr(v)).map(String);
}

export function IsGatewayCidrList(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isGatewayCidrList',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) =>
          Array.isArray(value) && invalidGatewayCidrs(value).length === 0,
        defaultMessage: (args) => {
          if (!Array.isArray(args?.value)) {
            return `${propertyName} must be a list of IPv4/IPv6 addresses or CIDR ranges`;
          }
          const invalid = invalidGatewayCidrs(args.value)
            .map((v) => `"${v}"`)
            .join(', ');
          return `${propertyName}: ${invalid} is not a valid IPv4/IPv6 address or CIDR range (e.g. 203.0.113.7 or 203.0.113.0/24)`;
        },
      },
    });
}
