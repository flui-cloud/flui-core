import { ConfigService } from '@nestjs/config';
import {
  TOPOLOGY_REGION_LABEL,
  TOPOLOGY_ZONE_LABEL,
  missingTopologyLabels,
  topologyLabels,
} from './node-topology';
import { ByosCapabilitiesService } from '../implementations/byos/byos-capabilities.service';
import { ContaboCapabilitiesService } from '../implementations/contabo/contabo-capabilities.service';
import { HetznerCapabilitiesService } from '../implementations/hetzner/hetzner-capabilities.service';
import { OvhCapabilitiesService } from '../implementations/ovh/ovh-capabilities.service';
import { ScalewayCapabilitiesService } from '../implementations/scaleway/scaleway-capabilities.service';
import { ICredentialProvider } from '../interfaces/credential-provider.interface';

const config = {
  get: (_key: string, fallback?: unknown) => fallback,
} as unknown as ConfigService;
const credentials = {} as unknown as ICredentialProvider;

describe('where a node sits, as its provider declares it', () => {
  const hetzner = new HetznerCapabilitiesService(config, credentials);
  const scaleway = new ScalewayCapabilitiesService(credentials);

  it('puts a Hetzner node in its location, inside the network zone that covers it', () => {
    expect(hetzner.nodeTopology('fsn1')).toEqual({
      zone: 'fsn1',
      region: 'eu-central',
    });
    expect(hetzner.nodeTopology('hel1')).toEqual({
      zone: 'hel1',
      region: 'eu-central',
    });
    expect(hetzner.nodeTopology('ash')).toEqual({
      zone: 'ash',
      region: 'us-east',
    });
  });

  it('gives a Hetzner location no network zone covers no topology at all', () => {
    expect(hetzner.nodeTopology('xyz1')).toBeNull();
    expect(hetzner.nodeTopology('')).toBeNull();
    expect(hetzner.nodeTopology(null)).toBeNull();
  });

  it('puts a Scaleway node in its zone, and a bare region in its first zone', () => {
    expect(scaleway.nodeTopology('fr-par-2')).toEqual({
      zone: 'fr-par-2',
      region: 'fr-par',
    });
    expect(scaleway.nodeTopology('nl-ams')).toEqual({
      zone: 'nl-ams-1',
      region: 'nl-ams',
    });
    expect(scaleway.nodeTopology(undefined)).toBeNull();
  });

  it('declares nothing for providers whose failure domains are not mapped', () => {
    expect(
      new OvhCapabilitiesService(config, credentials).nodeTopology(),
    ).toBeNull();
    expect(new ContaboCapabilitiesService(config).nodeTopology()).toBeNull();
    expect(new ByosCapabilitiesService().nodeTopology()).toBeNull();
  });
});

describe('the labels a topology becomes', () => {
  it('is the standard zone and region pair', () => {
    expect(topologyLabels({ zone: 'nbg1', region: 'eu-central' })).toEqual({
      [TOPOLOGY_ZONE_LABEL]: 'nbg1',
      [TOPOLOGY_REGION_LABEL]: 'eu-central',
    });
  });

  it('is nothing when there is no topology or a value would not be a valid label', () => {
    expect(topologyLabels(null)).toEqual({});
    expect(topologyLabels({ zone: 'fsn1 x', region: 'eu-central' })).toEqual(
      {},
    );
    expect(topologyLabels({ zone: 'fsn1', region: 'EU' })).toEqual({});
  });
});

describe('which topology labels a node still needs', () => {
  const desired = {
    [TOPOLOGY_ZONE_LABEL]: 'fsn1',
    [TOPOLOGY_REGION_LABEL]: 'eu-central',
  };

  it('adds the ones that are missing and keeps the others', () => {
    expect(
      missingTopologyLabels(
        {
          'kubernetes.io/hostname': 'n1',
          [TOPOLOGY_REGION_LABEL]: 'eu-central',
        },
        desired,
      ),
    ).toEqual({ add: { [TOPOLOGY_ZONE_LABEL]: 'fsn1' }, conflicts: [] });
  });

  it('never overwrites a label someone set to another value, and says so', () => {
    expect(
      missingTopologyLabels({ [TOPOLOGY_ZONE_LABEL]: 'fsn1-dc14' }, desired),
    ).toEqual({
      add: { [TOPOLOGY_REGION_LABEL]: 'eu-central' },
      conflicts: [`${TOPOLOGY_ZONE_LABEL}=fsn1-dc14`],
    });
  });

  it('asks for nothing when the node already carries them', () => {
    expect(missingTopologyLabels({ ...desired }, desired)).toEqual({
      add: {},
      conflicts: [],
    });
  });
});
