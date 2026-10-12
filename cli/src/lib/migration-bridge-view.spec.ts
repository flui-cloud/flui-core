import { bridgeRows } from './migration-bridge-view';

describe('bridgeRows', () => {
  it('shows why a migration moves DNS only', () => {
    expect(
      bridgeRows({
        mode: 'dns-only',
        skipReason: 'The bridge was turned off when the migration was created.',
        state: null,
        hosts: [],
        readyToClose: false,
        closableAt: null,
        summary:
          'No bridge: The bridge was turned off when the migration was created.',
      }),
    ).toEqual([
      ['Bridge', 'none (DNS only)'],
      ['Why', 'The bridge was turned off when the migration was created.'],
    ]);
  });

  it('shows an open bridge with its names and when it may close', () => {
    expect(
      bridgeRows({
        mode: 'bridge',
        skipReason: null,
        state: 'active',
        hosts: [
          {
            fqdn: 'shop.example.com',
            certificate: 'dns-01',
            certificateReady: true,
          },
        ],
        activatedAt: '2026-10-11T11:50:00.000Z',
        dnsFlippedAt: '2026-10-11T11:55:00.000Z',
        ageSeconds: 600,
        readyToClose: false,
        closableAt: '2026-10-11T12:05:00.000Z',
        summary:
          'The old cluster forwards to the new one; safe to close from 2026-10-11T12:05:00.000Z.',
      }),
    ).toEqual([
      ['Bridge', 'active, open for 10m'],
      ['Names', 'shop.example.com (certificate: dns-01)'],
      ['DNS moved', '2026-10-11T11:55:00.000Z'],
      ['Closable', 'from 2026-10-11T12:05:00.000Z'],
      [
        '',
        'The old cluster forwards to the new one; safe to close from 2026-10-11T12:05:00.000Z.',
      ],
    ]);
  });

  it('prints nothing for a migration without a bridge block', () => {
    expect(bridgeRows(null)).toEqual([]);
    expect(bridgeRows(undefined)).toEqual([]);
  });
});
