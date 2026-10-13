import {
  networkZoneForRegion,
  regionsServedByNetworkZone,
} from './network-zones';
import { VNetTopology } from '../../management/entities/provider-capabilities.entity';

const regional = (zones: VNetTopology['zones']): VNetTopology => ({
  scope: 'regional',
  zones,
  supportsSubnets: false,
  subnetPerZone: false,
  supportsRoutes: false,
  vnetIpRange: { minPrefix: 8, maxPrefix: 28 },
  subnetIpRange: { minPrefix: 8, maxPrefix: 28 },
});

const scaleway = regional([
  { id: 'fr-par', displayName: 'Paris', coveredRegions: ['fr-par'] },
  { id: 'nl-ams', displayName: 'Amsterdam', coveredRegions: ['nl-ams'] },
]);
const hetzner = regional([
  {
    id: 'eu-central',
    displayName: 'EU',
    coveredRegions: ['fsn1', 'nbg1', 'hel1'],
  },
]);

describe('network zones', () => {
  it('a network serves only the regions its zone covers', () => {
    expect(regionsServedByNetworkZone(scaleway, 'fr-par')).toEqual(['fr-par']);
    expect(regionsServedByNetworkZone(hetzner, 'eu-central')).toEqual([
      'fsn1',
      'nbg1',
      'hel1',
    ]);
  });

  it('claims nothing where the provider declares no zones or no regional scope', () => {
    expect(regionsServedByNetworkZone(regional([]), 'GRA')).toBeNull();
    expect(
      regionsServedByNetworkZone({ ...scaleway, scope: 'manual' }, 'fr-par'),
    ).toBeNull();
    expect(regionsServedByNetworkZone(null, 'fr-par')).toBeNull();
  });

  it('a new network for a region takes the zone that covers it', () => {
    expect(networkZoneForRegion(scaleway, 'nl-ams')).toBe('nl-ams');
    expect(networkZoneForRegion(hetzner, 'nbg1')).toBe('eu-central');
    expect(networkZoneForRegion(scaleway, 'pl-waw')).toBeNull();
  });
});
