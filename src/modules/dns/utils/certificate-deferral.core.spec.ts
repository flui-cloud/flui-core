import {
  DEFERRAL_LIMIT_MS,
  deferredCertificate,
  publicationVerdict,
} from './certificate-deferral.core';

const FQDN = 'shop.example.com';
const IP = '203.0.113.7';

describe('publicationVerdict', () => {
  it('is published only when every nameserver answers with the address', () => {
    expect(
      publicationVerdict(FQDN, IP, [
        { nameserver: 'ns1', addresses: [IP] },
        { nameserver: 'ns2', addresses: [IP] },
      ]).published,
    ).toBe(true);
  });

  it('names the nameservers that do not have it yet', () => {
    const v = publicationVerdict(FQDN, IP, [
      { nameserver: 'ns1', addresses: [IP] },
      { nameserver: 'ns2', addresses: null },
    ]);
    expect(v).toEqual({
      published: false,
      detail: 'shop.example.com is not published yet on ns2.',
    });
  });

  it('refuses an old address instead of taking any answer', () => {
    const v = publicationVerdict(FQDN, IP, [
      { nameserver: 'ns1', addresses: ['198.51.100.9'] },
    ]);
    expect(v.detail).toBe(
      'shop.example.com answers 198.51.100.9 on ns1, not 203.0.113.7.',
    );
  });

  it('accepts any answer when the value is not an IPv4 address', () => {
    expect(
      publicationVerdict(FQDN, 'lb.example.net', [
        { nameserver: 'ns1', addresses: ['198.51.100.9'] },
      ]).published,
    ).toBe(true);
  });

  it('counts a name without an A record as existing', () => {
    expect(
      publicationVerdict(FQDN, IP, [
        { nameserver: 'ns1', addresses: null, noData: true },
      ]).published,
    ).toBe(true);
  });
});

describe('deferredCertificate', () => {
  const now = new Date('2026-09-26T10:00:00Z');

  it('starts the wait now when there was none', () => {
    const d = deferredCertificate(null, now, 'x.');
    expect(d.status).toBe('pending');
    expect(d.since).toEqual(now);
    expect(d.message).toContain('usually takes minutes, at most an hour');
  });

  it('keeps the start of a wait already running', () => {
    const since = new Date(now.getTime() - 10 * 60_000);
    expect(deferredCertificate(since, now, 'x.').since).toEqual(since);
  });

  it('turns into an error after an hour, with the cause', () => {
    const since = new Date(now.getTime() - DEFERRAL_LIMIT_MS);
    const d = deferredCertificate(
      since,
      now,
      'shop.example.com is not published yet on ns2.',
    );
    expect(d.status).toBe('failed');
    expect(d.message).toBe(
      'Still not published after an hour: shop.example.com is not published yet on ns2. Check the record at the DNS provider, then Sync.',
    );
  });
});
