jest.mock('@kubernetes/client-node', () => ({}));

import { ClusterCapacityService } from './cluster-capacity.service';

const size = (name: string, architecture: 'x86' | 'arm', cores: number) => ({
  id: name,
  name,
  cores,
  memory: cores * 2,
  disk: 40,
  cpuType: 'shared',
  architecture,
  deprecated: false,
  prices: [
    {
      location: 'fr-par',
      priceHourly: { net: '0.01', gross: '0.01' },
      priceMonthly: { net: String(cores * 5), gross: String(cores * 5) },
    },
  ],
});

const build = (currentServerType: string) =>
  new ClusterCapacityService(
    {
      findOne: async () => ({
        id: 'c1',
        provider: 'scaleway',
        kubeconfigEncrypted: 'sealed',
      }),
    } as never,
    {
      findOne: async () => ({ providerResourceId: 'fr-par-1/abc' }),
    } as never,
    {
      getMasterNodeCapacity: async () => ({
        nodeName: 'demo-master',
        allocatable: { cpu: 4000, memory: 8000 },
        requested: { cpu: 1000, memory: 2000 },
      }),
    } as never,
    { decrypt: () => 'kubeconfig' } as never,
    {
      getProvider: () => ({
        getServerDetailsAsDto: async () => ({
          server_type: currentServerType,
        }),
        getNodeSizes: async () => [
          size('DEV1-M', 'x86', 3),
          size('DEV1-L', 'x86', 4),
          size('COPARM1-2C-8G', 'arm', 2),
          size('COPARM1-4C-16G', 'arm', 4),
        ],
      }),
    } as never,
    { getStatus: async () => ({ volume: null }) } as never,
  );

describe('a capacity plan offers every architecture, each named', () => {
  it('lists arm types beside x86 ones, each saying its architecture', async () => {
    const plan = await build('DEV1-M').getPlan('c1');

    expect(plan.candidates.map((c) => [c.name, c.architecture]).sort()).toEqual(
      [
        ['COPARM1-2C-8G', 'arm'],
        ['COPARM1-4C-16G', 'arm'],
        ['DEV1-L', 'x86'],
        ['DEV1-M', 'x86'],
      ],
    );
    expect(plan.master?.architecture).toBe('x86');
  });

  it('shows an arm master as what it is', async () => {
    const plan = await build('COPARM1-2C-8G').getPlan('c1');

    expect(plan.master?.architecture).toBe('arm');
    const current = plan.candidates.find((c) => c.direction === 'current');
    expect(current).toMatchObject({
      name: 'COPARM1-2C-8G',
      architecture: 'arm',
    });
  });
});
