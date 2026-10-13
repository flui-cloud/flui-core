import { hashIp } from './visitor-ip';

describe('hashIp', () => {
  it('keeps no readable address, and the same address always hashes the same', () => {
    const h = hashIp('203.0.113.7', 'key');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('203');
    expect(hashIp('203.0.113.7', 'key')).toBe(h);
    expect(hashIp('::ffff:203.0.113.7', 'key')).toBe(h);
    expect(hashIp('203.0.113.7', 'other')).not.toBe(h);
  });
});
