import { createHmac } from 'node:crypto';

/** A visitor's address is only ever kept as this: comparable, not readable. */
export function hashIp(ip: string, key: Buffer | string): string {
  const normal = ip
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/, '');
  return createHmac('sha256', key).update(normal).digest('hex');
}
