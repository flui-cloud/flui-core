jest.mock('@kubernetes/client-node', () => ({}));

import { BadRequestException } from '@nestjs/common';
import { ClusterHaService } from '../../../cluster-ha/services/cluster-ha.service';
import { ClusterScalingService } from './cluster-scaling.service';
import { HaNodesService } from './ha-nodes.service';

function setup() {
  const addWorkers = jest.fn(async () => ({ id: 'op-1' }));
  const service = new HaNodesService(
    {
      inspect: jest.fn(async () => ({
        cluster: { name: 'lab' },
        state: {
          unsupported: null,
          topology: {
            zones: [
              { zone: 'fsn1', role: 'data', servers: ['m'], dataHosts: ['m'] },
              { zone: 'nbg1', role: 'data', servers: [], dataHosts: ['w1'] },
              { zone: 'hel1', role: 'vote', servers: [], dataHosts: [] },
            ],
          },
          missing: [{ role: 'server', zone: 'hel1', why: '' }],
        },
      })),
    } as unknown as ClusterHaService,
    { addWorkers } as unknown as ClusterScalingService,
  );
  return { service, addWorkers };
}

describe('HaNodesService', () => {
  it('buys one node in the location, joined with its role', async () => {
    const { service, addWorkers } = setup();
    await expect(
      service.add(
        'c1',
        { role: 'server', zone: 'hel1', serverType: 'cax21' },
        'dawit',
      ),
    ).resolves.toEqual({ operationId: 'op-1', role: 'server', zone: 'hel1' });
    expect(addWorkers).toHaveBeenCalledWith(
      'c1',
      1,
      'cax21',
      'hel1',
      'dawit',
      'server',
    );
  });

  it('buys nothing when the role is not missing there', async () => {
    const { service, addWorkers } = setup();
    await expect(
      service.add('c1', { role: 'server', zone: 'fsn1' }, 'dawit'),
    ).rejects.toThrow(BadRequestException);
    expect(addWorkers).not.toHaveBeenCalled();
  });
});
