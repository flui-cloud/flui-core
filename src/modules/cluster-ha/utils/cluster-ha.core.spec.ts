import {
  ClusterHaNode,
  clusterHaNodesFrom,
  clusterHaRegion,
  clusterHaState,
} from './cluster-ha.core';
import { HaTopology } from '../../providers/core/ha-topology';

const hetzner: HaTopology = {
  region: 'eu-central',
  zones: ['fsn1', 'nbg1', 'hel1'],
  dataZones: ['fsn1', 'nbg1'],
  validated: true,
};
const layout = { topology: hetzner };

const n = (
  name: string,
  zone: string | undefined,
  server = false,
  schedulable = true,
): ClusterHaNode => ({
  name,
  zone,
  region: zone ? 'eu-central' : undefined,
  server,
  ready: true,
  schedulable,
});

describe('cluster HA state', () => {
  it('a master and a worker are standard and need a server in each other location', () => {
    const s = clusterHaState(
      [n('master', 'fsn1', true, false), n('w1', 'fsn1')],
      layout,
    );
    expect(s.level).toBe('standard');
    expect(s.missing).toEqual([
      expect.objectContaining({ role: 'server', zone: 'nbg1' }),
      expect.objectContaining({ role: 'server', zone: 'hel1' }),
      expect.objectContaining({ role: 'data-host', zone: 'nbg1' }),
    ]);
    expect(s.doesNotSurvive.join(' ')).toContain('the loss of the master');
  });

  it('three servers in Falkenstein, Nuremberg and Helsinki that take applications reach three locations', () => {
    const s = clusterHaState(
      [n('s1', 'fsn1', true), n('s2', 'nbg1', true), n('s3', 'hel1', true)],
      layout,
    );
    expect(s.level).toBe('three-locations');
    expect(s.missing).toEqual([]);
    expect(s.topology?.zones.map((z) => [z.zone, z.role])).toEqual([
      ['fsn1', 'data'],
      ['nbg1', 'data'],
      ['hel1', 'vote'],
    ]);
    expect(s.survives.join(' ')).toContain('the loss of a whole location');
  });

  it('a data location needs a node that takes applications, the voting one does not', () => {
    const s = clusterHaState(
      [
        n('s1', 'fsn1', true),
        n('s2', 'nbg1', true, false),
        n('s3', 'hel1', true, false),
      ],
      layout,
    );
    expect(s.level).toBe('standard');
    expect(s.missing).toEqual([
      expect.objectContaining({ role: 'data-host', zone: 'nbg1' }),
    ]);
  });

  it('warns that two servers are more fragile than one', () => {
    const s = clusterHaState(
      [n('s1', 'fsn1', true), n('s2', 'nbg1', true), n('w1', 'fsn1')],
      layout,
    );
    expect(s.warnings.join(' ')).toContain('more fragile than one');
  });

  it('a region with no validated layout says why, and stays standard', () => {
    const s = clusterHaState([n('s1', 'fsn1', true)], {
      topology: null,
      reason:
        'Flui has not validated a highly available layout for us-east yet.',
    });
    expect(s.level).toBe('standard');
    expect(s.topology).toBeNull();
    expect(s.unsupported).toContain('us-east');
  });

  it('a forced layout says it was not measured', () => {
    const s = clusterHaState(
      [n('a', 'z1', true), n('b', 'z2', true), n('c', 'z3', true)],
      {
        topology: {
          region: 'r',
          zones: ['z1', 'z2', 'z3'],
          dataZones: ['z1', 'z2', 'z3'],
          validated: false,
        },
      },
    );
    expect(s.level).toBe('three-locations');
    expect(s.warnings.join(' ')).toContain('was forced');
  });

  it('nodes without a known location are reported', () => {
    const s = clusterHaState([n('master', undefined, true, false)], layout);
    expect(s.warnings.join(' ')).toContain('No node reports its location');
  });

  it('reads roles, locations, region and readiness from the nodes', () => {
    const nodes = clusterHaNodesFrom([
      {
        metadata: {
          name: 'm',
          labels: {
            'node-role.kubernetes.io/control-plane': 'true',
            'topology.kubernetes.io/zone': 'fsn1',
            'topology.kubernetes.io/region': 'eu-central',
          },
        },
        status: { conditions: [{ type: 'Ready', status: 'True' }] },
        spec: { taints: [{ key: 'x', effect: 'NoSchedule' }] },
      },
      {
        metadata: { name: 'w', labels: {} },
        status: { conditions: [{ type: 'Ready', status: 'False' }] },
      },
    ]);
    expect(nodes).toEqual([
      {
        name: 'm',
        zone: 'fsn1',
        region: 'eu-central',
        server: true,
        ready: true,
        schedulable: false,
      },
      {
        name: 'w',
        zone: undefined,
        region: undefined,
        server: false,
        ready: false,
        schedulable: false,
      },
    ]);
    expect(clusterHaRegion(nodes)).toBe('eu-central');
  });
});
