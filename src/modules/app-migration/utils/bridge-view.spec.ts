import { bridgeView } from './bridge-view';

const NOW = new Date('2026-10-11T12:00:00.000Z');

describe('bridgeView', () => {
  it('says why there is no bridge', () => {
    expect(
      bridgeView(
        {
          bridgeState: {
            mode: 'dns-only',
            skipReason:
              'The bridge was turned off when the migration was created.',
            state: null,
            hosts: [],
          },
        },
        NOW,
      ),
    ).toEqual(
      expect.objectContaining({
        mode: 'dns-only',
        skipReason: 'The bridge was turned off when the migration was created.',
        readyToClose: false,
        closableAt: null,
        summary:
          'No bridge: The bridge was turned off when the migration was created.',
      }),
    );
  });

  it('holds the close until twice the record TTL after the DNS switch', () => {
    const view = bridgeView(
      {
        bridgeState: {
          mode: 'bridge',
          skipReason: null,
          state: 'active',
          hosts: [
            {
              fqdn: 'shop.example.com',
              namespace: 'ns',
              endpointIds: ['e1'],
              secretName: 'tls-shop-example-com',
              certificate: 'dns-01',
              certificateReady: true,
              certificateMessage: null,
              certificateRequired: true,
            },
          ],
          activatedAt: '2026-10-11T11:50:00.000Z',
          dnsFlippedAt: '2026-10-11T11:55:00.000Z',
          recordTtlSeconds: 300,
        },
      },
      NOW,
    );
    expect(view).toEqual(
      expect.objectContaining({
        state: 'active',
        closableAt: '2026-10-11T12:05:00.000Z',
        readyToClose: false,
        blockedBy: 'ttl',
        ageSeconds: 600,
        hosts: [
          {
            fqdn: 'shop.example.com',
            certificate: 'dns-01',
            certificateReady: true,
          },
        ],
      }),
    );
    expect(view?.summary).toMatch(/2026-10-11T12:05:00.000Z/);
  });

  it('is ready to close once that time has passed', () => {
    const view = bridgeView(
      {
        bridgeState: {
          mode: 'bridge',
          skipReason: null,
          state: 'active',
          hosts: [],
          dnsFlippedAt: '2026-10-11T11:00:00.000Z',
          recordTtlSeconds: 60,
        },
      },
      NOW,
    );
    expect(view?.readyToClose).toBe(true);
    expect(view?.blockedBy).toBeNull();
  });

  it('assumes five minutes when the record TTL could not be read', () => {
    const view = bridgeView(
      {
        bridgeState: {
          mode: 'bridge',
          skipReason: null,
          state: 'active',
          hosts: [],
          dnsFlippedAt: '2026-10-11T11:55:00.000Z',
          recordTtlSeconds: null,
        },
      },
      NOW,
    );
    expect(view?.closableAt).toBe('2026-10-11T12:05:00.000Z');
  });

  it('carries what Flui did about a refused certificate in the summary every surface prints', () => {
    const note =
      "Let's Encrypt refused the certificate for shop.example.com (unauthorized: authorizations for these identifiers not valid); retried now.";
    const view = bridgeView(
      {
        bridgeState: {
          mode: 'bridge',
          skipReason: null,
          state: 'preparing',
          hosts: [
            {
              fqdn: 'shop.example.com',
              namespace: 'ns',
              endpointIds: ['e1'],
              secretName: 'tls-shop-example-com',
              certificate: 'dns-01',
              certificateReady: false,
              certificateMessage: 'no certificate yet',
              certificateRequired: true,
              certificateNote: note,
            },
          ],
        },
      },
      NOW,
    );
    expect(view?.summary).toBe(
      `Bridge prepared; waiting for a valid certificate on the new cluster for shop.example.com. ${note}`,
    );
    expect(view?.hosts[0].certificateNote).toBe(note);
  });

  it('has nothing to show for a migration made before the bridge existed', () => {
    expect(bridgeView({ bridgeState: null }, NOW)).toBeNull();
  });
});
