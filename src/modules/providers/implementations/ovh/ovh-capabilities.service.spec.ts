import { ConfigService } from '@nestjs/config';
import { OvhCapabilitiesService } from './ovh-capabilities.service';
import { CredentialType } from '../../../management/entities/credentials.entity';

const buildClient = jest.fn();
jest.mock('./ovh-openstack-client.factory', () => ({
  buildOvhOpenStackClient: (...args: unknown[]) => buildClient(...args),
}));

const config = {
  get: (_k: string, d?: string) => d,
} as unknown as ConfigService;

const CREDENTIALS = {
  type: CredentialType.ACCESS_KEY_SECRET,
  accessKey: 'os-user',
  secretKey: 'os-pass',
} as never;

function credentialProvider(stored = true) {
  return {
    getActiveAccessKeyPair: jest.fn(() =>
      stored
        ? Promise.resolve({ accessKey: 'os-user', secretKey: 'os-pass' })
        : Promise.reject(new Error('none')),
    ),
  } as never;
}

/**
 * Region availability on OVH is per-project, so the only correct list is the
 * one this credential can reach. These cover the moment that is easiest to get
 * wrong: the configuration wizard asks for regions before the credential it is
 * validating has been stored anywhere.
 */
describe('OvhCapabilitiesService regions', () => {
  beforeEach(() => buildClient.mockReset());

  it('returns the regions discovered while validating, before anything is stored', async () => {
    buildClient.mockResolvedValue({
      testConnection: async () => ({ success: true }),
      regions: async () => ['GRA11', 'EU-SOUTH-MIL', 'EU-WEST-PAR'],
    });
    const service = new OvhCapabilitiesService(
      config,
      credentialProvider(false),
    );

    const result = await service.validateCredentials(CREDENTIALS);

    expect(result.success).toBe(true);
    expect(result.availableRegions?.map((r) => r.id)).toEqual([
      'EU-SOUTH-MIL',
      'EU-WEST-PAR',
      'GRA',
    ]);
    // The wizard renders country, displayName and available.
    const milan = result.availableRegions?.find((r) => r.id === 'EU-SOUTH-MIL');
    expect(milan).toEqual(
      expect.objectContaining({
        name: 'Milan',
        displayName: 'Milan, Italy',
        location: 'Milan, Italy',
        country: 'Italy',
        available: true,
      }),
    );
  });

  it('still validates when the region read fails, rather than failing the credential', async () => {
    buildClient.mockResolvedValue({
      testConnection: async () => ({ success: true }),
      regions: async () => {
        throw new Error('catalog unavailable');
      },
    });
    const service = new OvhCapabilitiesService(
      config,
      credentialProvider(false),
    );

    const result = await service.validateCredentials(CREDENTIALS);

    expect(result.success).toBe(true);
    expect(result.availableRegions).toEqual([]);
  });

  it('reports an invalid credential without inventing regions', async () => {
    buildClient.mockResolvedValue({
      testConnection: async () => ({ success: false, error: 'bad password' }),
      regions: async () => ['GRA11'],
    });
    const service = new OvhCapabilitiesService(
      config,
      credentialProvider(false),
    );

    const result = await service.validateCredentials(CREDENTIALS);

    expect(result.success).toBe(false);
    expect(result.availableRegions).toBeUndefined();
  });

  it('falls back to the static list when no credential is stored', async () => {
    const service = new OvhCapabilitiesService(
      config,
      credentialProvider(false),
    );

    const regions = await service.getAvailableRegions();

    expect(regions.length).toBeGreaterThan(0);
    expect(buildClient).not.toHaveBeenCalled();
  });
});

describe('OVH capabilities — the private network it actually has', () => {
  const topology = () =>
    new OvhCapabilitiesService(
      { get: jest.fn() } as any,
      { getOpenStackClient: jest.fn() } as any,
    ).getStaticCapabilities();

  it('declares the Neutron network, regional and with subnets', () => {
    const caps = topology();
    expect(caps.vnetTopology).toMatchObject({
      scope: 'regional',
      supportsSubnets: true,
      subnetPerZone: true,
    });
  });

  it('demands a private network, like every provider that has one', () => {
    // Without this the whole hot-attach wait never runs: no network means no
    // `networks` on the create call, which means the netplan snippet is never
    // injected and the node has nothing to wait for.
    expect(topology().vnetRequired).toBe(true);
  });

  it('does not ask Flui to build a network it already has', () => {
    expect(topology().supportsFluiManagedVNet).toBe(false);
  });

  it('leaves the zone list to the credential that can see them', () => {
    // A static list goes stale; the regions come from the Keystone catalogue.
    expect(topology().vnetTopology?.zones).toEqual([]);
  });
});
