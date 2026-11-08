import {
  controlPodsOnCopies,
  parseReplicatedPoolOutput,
  renderLinstorCluster,
  renderReplicatedStorageClass,
  renderSatelliteConfigurations,
  replicatedPoolHostScript,
  replicatedVolumesFeasibility,
  volumesBlockingFailover,
  storageNodeWarnings,
  staleCopyWarnings,
  volumeCopiesFrom,
  voteZonesOf,
  stuckSatellites,
} from './replicated-volumes.core';
import { HaTopology } from '../../providers/core/ha-topology';

const hetzner: HaTopology = {
  region: 'eu-central',
  zones: ['fsn1', 'nbg1', 'hel1'],
  dataZones: ['fsn1', 'nbg1'],
  validated: true,
  measured: true,
};

const node = (name: string, zone?: string, schedulable = true) => ({
  name,
  zone,
  schedulable,
});

describe('replicated volumes core', () => {
  describe('renderReplicatedStorageClass', () => {
    const sc = renderReplicatedStorageClass() as {
      metadata: { name: string };
      volumeBindingMode: string;
      parameters: Record<string, string>;
    };

    it('keeps two copies on the prepared pool and the pod next to one', () => {
      expect(sc.metadata.name).toBe('flui-replicated');
      expect(sc.volumeBindingMode).toBe('WaitForFirstConsumer');
      expect(sc.parameters['linstor.csi.linbit.com/storagePool']).toBe(
        'flui-replicated',
      );
      expect(sc.parameters['linstor.csi.linbit.com/placementCount']).toBe('2');
      expect(
        sc.parameters['linstor.csi.linbit.com/allowRemoteVolumeAccess'],
      ).toBe('false');
    });

    it('asks for quorum so a node cut off stops confirming writes', () => {
      const p = 'property.linstor.csi.linbit.com/DrbdOptions';
      expect(sc.parameters[`${p}/auto-quorum`]).toBe('suspend-io');
      expect(sc.parameters[`${p}/Resource/on-no-data-accessible`]).toBe(
        'suspend-io',
      );
      expect(sc.parameters[`${p}/Resource/on-suspended-primary-outdated`]).toBe(
        'force-secondary',
      );
    });

    it('keeps one copy per location for data', () => {
      const three = renderReplicatedStorageClass(3) as {
        parameters: Record<string, string>;
      };
      expect(three.parameters['linstor.csi.linbit.com/placementCount']).toBe(
        '3',
      );
    });

    it('keeps each copy, and the tie-breaker, in a location of its own', () => {
      expect(sc.parameters['linstor.csi.linbit.com/replicasOnDifferent']).toBe(
        'Aux/topology/topology.kubernetes.io/zone',
      );
    });
  });

  it('runs satellites on the host network and keeps data on prepared nodes only', () => {
    const [network, pool] = renderSatelliteConfigurations() as Array<{
      spec: Record<string, any>;
    }>;
    expect(network.spec.nodeSelector).toBeUndefined();
    expect(network.spec.podTemplate.spec.hostNetwork).toBe(true);
    expect(network.spec.podTemplate.metadata.annotations).toEqual({
      'prometheus.io/scrape': 'true',
      'prometheus.io/port': '9942',
      'prometheus.io/path': '/metrics',
    });
    expect(pool.spec.nodeSelector).toEqual({
      'flui.cloud/replicated-storage': 'true',
    });
    expect(pool.spec.storagePools[0]).toEqual({
      name: 'flui-replicated',
      lvmPool: { volumeGroup: 'flui-replicated' },
    });
  });

  it('leaves the NFS server of the engine off', () => {
    const cluster = renderLinstorCluster() as { spec: Record<string, any> };
    expect(cluster.spec.nfsServer).toEqual({ enabled: false });
    expect(cluster.spec.highAvailabilityController).toEqual({ enabled: true });
  });

  it('keeps the single-copy engine components off the nodes that hold data', () => {
    const cluster = renderLinstorCluster(['hel1']) as {
      spec: Record<string, any>;
    };
    for (const part of ['controller', 'csiController', 'affinityController']) {
      const spec = cluster.spec[part].podTemplate.spec;
      expect(
        spec.affinity.nodeAffinity
          .requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0]
          .matchExpressions,
      ).toContainEqual({
        key: 'flui.cloud/replicated-storage',
        operator: 'DoesNotExist',
      });
      expect(spec.tolerations).toEqual([
        { operator: 'Exists', effect: 'NoSchedule' },
      ]);
    }
  });

  describe('replicatedPoolHostScript', () => {
    const script = replicatedPoolHostScript(20);

    it('builds a plain volume group on a direct-I/O loop with 4K sectors', () => {
      expect(script).toContain(
        'losetup --find --show --direct-io=on --sector-size 4096',
      );
      expect(script).toContain('vgcreate -q "$VG"');
      expect(script).not.toContain('thin');
      expect(script).toContain('fallocate -l 20G');
    });

    it('brings the pool back at boot before K3s starts', () => {
      expect(script).toContain('Before=k3s.service k3s-agent.service');
      expect(script).toContain('systemctl enable flui-replicated-pool.service');
    });

    it('refuses a size that is not a whole number of GiB', () => {
      expect(() => replicatedPoolHostScript(0)).toThrow();
      expect(() => replicatedPoolHostScript(1.5)).toThrow();
    });
  });

  describe('parseReplicatedPoolOutput', () => {
    it('reads a ready pool', () => {
      expect(
        parseReplicatedPoolOutput('x\nPOOL flui-replicated 20.00\n'),
      ).toEqual({ kind: 'ready', sizeGiB: 20 });
    });

    it('reads the two refusals', () => {
      expect(parseReplicatedPoolOutput('NOHEADERS 6.8.0-1-generic')).toEqual({
        kind: 'no-headers',
        kernel: '6.8.0-1-generic',
      });
      expect(parseReplicatedPoolOutput('NOSPACE 12')).toEqual({
        kind: 'no-space',
        freeGiB: 12,
      });
    });

    it('keeps anything else as unknown', () => {
      expect(parseReplicatedPoolOutput('boom').kind).toBe('unknown');
    });
  });

  describe('replicatedVolumesFeasibility', () => {
    const lab = [
      node('master', 'fsn1'),
      node('w1', 'nbg1'),
      node('w2', 'fsn1'),
      node('w3', 'hel1'),
    ];

    it('puts one copy in each location for data and the vote in the third', () => {
      expect(replicatedVolumesFeasibility(lab, hetzner)).toEqual({
        feasible: true,
        zones: ['fsn1', 'nbg1'],
        storageNodes: ['master', 'w1'],
        tieBreakers: ['w3'],
      });
    });

    it('keeps nodes already prepared when they still fit', () => {
      expect(
        replicatedVolumesFeasibility(lab, hetzner, { prepared: ['w1', 'w2'] }),
      ).toMatchObject({ storageNodes: ['w1', 'w2'] });
    });

    it('never puts a copy in the voting location', () => {
      const r = replicatedVolumesFeasibility(lab, hetzner, {
        requested: ['w1', 'w3'],
      });
      expect((r as { reason: string }).reason).toContain('fsn1 or nbg1');
    });

    it('refuses two copies in one location', () => {
      const r = replicatedVolumesFeasibility(lab, hetzner, {
        requested: ['master', 'w2'],
      });
      expect((r as { reason: string }).reason).toBe(
        'Name 2 nodes, one in each location for data: fsn1 and nbg1.',
      );
    });

    it('refuses a location for data with no node that takes applications', () => {
      const r = replicatedVolumesFeasibility(
        [node('m', 'fsn1'), node('w1', 'nbg1', false), node('w3', 'hel1')],
        hetzner,
      );
      expect((r as { reason: string }).reason).toContain('fsn1 and nbg1');
    });

    it('refuses without a node in the third location', () => {
      const r = replicatedVolumesFeasibility(
        [node('m', 'fsn1'), node('w1', 'nbg1')],
        hetzner,
      );
      expect((r as { reason: string }).reason).toContain('third location');
    });

    it('names a node that is not there', () => {
      const r = replicatedVolumesFeasibility(lab, hetzner, {
        requested: ['w1', 'nope'],
      });
      expect((r as { reason: string }).reason).toContain('nope');
    });

    describe('where every location holds data', () => {
      const milan: HaTopology = {
        region: 'eu-south',
        zones: ['a', 'b', 'c'],
        dataZones: ['a', 'b', 'c'],
        validated: true,
        measured: true,
      };
      const servers = [node('s1', 'a'), node('s2', 'b'), node('s3', 'c')];

      it('puts a copy in each of the three, with no vote to cast', () => {
        expect(replicatedVolumesFeasibility(servers, milan)).toEqual({
          feasible: true,
          zones: ['a', 'b', 'c'],
          storageNodes: ['s1', 's2', 's3'],
          tieBreakers: [],
        });
      });

      it('refuses when one of them has no node that takes applications', () => {
        const r = replicatedVolumesFeasibility(
          [node('s1', 'a'), node('s2', 'b'), node('s3', 'c', false)],
          milan,
        );
        expect((r as { reason: string }).reason).toBe(
          'Replicated volumes need a node that takes applications in a, b and c.',
        );
      });

      it('refuses naming fewer nodes than locations', () => {
        const r = replicatedVolumesFeasibility(servers, milan, {
          requested: ['s1', 's2'],
        });
        expect((r as { reason: string }).reason).toBe(
          'Name 3 nodes, one in each location for data: a, b and c.',
        );
      });
    });
  });

  describe('volumesBlockingFailover', () => {
    it('is empty for an app without replicated volumes', () => {
      expect(
        volumesBlockingFailover([{ name: 'data', storageClass: 'flui-local' }]),
      ).toEqual([]);
    });

    it('names the volumes of another kind next to a replicated one', () => {
      expect(
        volumesBlockingFailover([
          { name: 'data', storageClass: 'flui-replicated' },
          { name: 'cache', storageClass: 'flui-local' },
          { name: 'uploads' },
        ]),
      ).toEqual(['cache', 'uploads']);
    });
  });

  it('finds the single-copy engine components that sit on a node with copies', () => {
    const pod = (name: string, nodeName: string) => ({
      metadata: { name },
      spec: { nodeName },
    });
    expect(
      controlPodsOnCopies(
        [
          pod('linstor-controller-694bf66d64-f9x9n', 'w1'),
          pod('linstor-csi-controller-ccdfbd4c6-smtrl', 'w3'),
          pod('linstor-affinity-controller-c95456f64-5l87p', 'w1'),
          pod('linstor-satellite.w1-abcde', 'w1'),
          pod('ha-controller-xdj2b', 'w1'),
        ],
        ['w1', 'w2'],
      ),
    ).toEqual([
      'linstor-controller-694bf66d64-f9x9n',
      'linstor-affinity-controller-c95456f64-5l87p',
    ]);
  });
});

describe('storage node warnings', () => {
  it('names a node with copies that takes no applications', () => {
    const nodes = [
      { name: 'master', zone: 'fsn1', schedulable: false },
      { name: 'w1', zone: 'fsn1', schedulable: true },
      { name: 'w2', zone: 'fsn1', schedulable: true },
    ];
    expect(storageNodeWarnings(nodes, ['w1', 'w2'])).toEqual([]);
    expect(storageNodeWarnings(nodes, ['master', 'w2'])).toEqual([
      expect.stringContaining('master holds copies but takes no applications'),
    ]);
  });
});

describe('copies that are not up to date', () => {
  const pv = 'pvc-a044c935';
  const resource = (node: string, disk: string, inUse = false) => ({
    name: pv,
    node_name: node,
    state: { in_use: inUse },
    volumes: [{ volume_number: 0, state: { disk_state: disk } }],
  });

  it('reads each copy from LINSTOR, the way the lab printed it', () => {
    const json = JSON.stringify([
      [
        resource('w1', 'UpToDate'),
        resource('w2', 'Inconsistent', true),
        resource('w3', 'Diskless'),
      ],
    ]);
    expect(volumeCopiesFrom(json)).toEqual([
      { volume: pv, node: 'w1', disk: 'UpToDate', inUse: false },
      { volume: pv, node: 'w2', disk: 'Inconsistent', inUse: true },
      { volume: pv, node: 'w3', disk: 'Diskless', inUse: false },
    ]);
  });

  it('says which copy is behind, which loss would stop the volume, and where the application runs', () => {
    const copies = volumeCopiesFrom(
      JSON.stringify([
        [
          resource('w1', 'UpToDate'),
          resource('w2', 'Inconsistent', true),
          resource('w3', 'Diskless'),
        ],
      ]),
    );
    expect(
      staleCopyWarnings(copies, new Map([[pv, 'p-personal/data-writer']])),
    ).toEqual([
      'The copy of p-personal/data-writer on w2 is not up to date (Inconsistent): until it is, losing w1 stops the volume. The application runs on this copy.',
    ]);
    expect(
      staleCopyWarnings(
        copies.map((c) => ({
          ...c,
          disk: c.node === 'w3' ? 'Diskless' : 'UpToDate',
        })),
        new Map(),
      ),
    ).toEqual([]);
  });
});

describe('where the engine runs its single-copy parts', () => {
  const topology: HaTopology = {
    region: 'eu-central',
    zones: ['fsn1', 'nbg1', 'hel1'],
    dataZones: ['fsn1', 'nbg1'],
    validated: true,
    measured: true,
  };

  it('keeps them in the voting location, away from copies', () => {
    expect(voteZonesOf(topology)).toEqual(['hel1']);
    const spec = renderLinstorCluster(['hel1']).spec as any;
    for (const part of ['controller', 'csiController', 'affinityController']) {
      expect(
        spec[part].podTemplate.spec.affinity.nodeAffinity
          .requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0]
          .matchExpressions,
      ).toEqual([
        { key: 'flui.cloud/replicated-storage', operator: 'DoesNotExist' },
        {
          key: 'topology.kubernetes.io/zone',
          operator: 'In',
          values: ['hel1'],
        },
      ]);
    }
  });

  it('only prefers a node without copies where every location holds data', () => {
    expect(
      voteZonesOf({
        ...topology,
        dataZones: topology.zones,
        validated: false,
        measured: false,
      }),
    ).toEqual([]);
    const spec = renderLinstorCluster([]).spec as any;
    for (const part of ['controller', 'csiController', 'affinityController']) {
      const affinity = spec[part].podTemplate.spec.affinity.nodeAffinity;
      expect(
        affinity.requiredDuringSchedulingIgnoredDuringExecution,
      ).toBeUndefined();
      expect(affinity.preferredDuringSchedulingIgnoredDuringExecution).toEqual([
        {
          weight: 100,
          preference: {
            matchExpressions: [
              {
                key: 'flui.cloud/replicated-storage',
                operator: 'DoesNotExist',
              },
            ],
          },
        },
      ]);
    }
  });
});

describe('the space for copies on a node', () => {
  it('is allocated on the disk for real, never left sparse', () => {
    const script = replicatedPoolHostScript(20);
    expect(script).toContain('fallocate -l 20G "$FILE"');
    expect(script).not.toContain('truncate -s');
  });

  it('allocates a pool made sparse before, without touching what it holds', () => {
    const script = replicatedPoolHostScript(20);
    expect(script).toContain(
      'fallocate -l "$(stat -c %s "$FILE")" "$FILE" || echo "NOALLOC"',
    );
  });

  it('says so when the space could not be set aside', () => {
    expect(
      parseReplicatedPoolOutput('NOALLOC\nPOOL flui-replicated 20'),
    ).toEqual({ kind: 'no-alloc' });
  });
});

describe('satellites that wait out a crash backoff', () => {
  const pod = (name: string, node: string, waiting?: string) => ({
    metadata: { name },
    spec: { nodeName: node },
    status: {
      initContainerStatuses: [
        { state: waiting ? { waiting: { reason: waiting } } : {} },
      ],
    },
  });

  it('names only the ones backing off on the nodes just prepared, never one still starting', () => {
    expect(
      stuckSatellites(
        [
          pod('linstor-satellite.hel1-abc', 'w2', 'CrashLoopBackOff'),
          pod('linstor-satellite.nbg1-xyz', 'w1', 'PodInitializing'),
          pod('linstor-satellite.fsn1-def', 'master'),
          pod('linstor-satellite.other-ghi', 'w9', 'CrashLoopBackOff'),
        ],
        ['master', 'w1', 'w2'],
      ),
    ).toEqual(['linstor-satellite.hel1-abc']);
  });
});
