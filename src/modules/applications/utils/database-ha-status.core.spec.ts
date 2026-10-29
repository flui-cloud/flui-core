import { ApplicationResourceStatus } from '../enums/application-resource-status.enum';
import {
  haClusterStatus,
  servesFromHaCluster,
} from './database-ha-status.core';

const active = {
  engine: 'cnpg',
  cluster: 'db-ha',
  durability: 'required',
  instances: 3,
  state: 'active',
  since: 'x',
} as const;

describe('a database that serves from its highly available cluster', () => {
  it('reads the single instance kept at zero copies as the way back, not as a failure', () => {
    expect(
      servesFromHaCluster(active, 'StatefulSet', { spec: { replicas: 0 } }),
    ).toBe(true);
    expect(
      servesFromHaCluster(active, 'StatefulSet', { spec: { replicas: 1 } }),
    ).toBe(false);
    expect(
      servesFromHaCluster({ ...active, state: 'copying' }, 'StatefulSet', {
        spec: { replicas: 0 },
      }),
    ).toBe(false);
    expect(
      servesFromHaCluster(null, 'StatefulSet', { spec: { replicas: 0 } }),
    ).toBe(false);
  });

  it('is ready with every instance up, degraded with one missing or during a failover', () => {
    const cluster = (phase: string, ready: number) => ({
      spec: { instances: 3 },
      status: { phase, readyInstances: ready, currentPrimary: 'db-ha-1' },
    });
    expect(haClusterStatus(cluster('Cluster in healthy state', 3))).toBe(
      ApplicationResourceStatus.READY,
    );
    expect(haClusterStatus(cluster('Cluster in healthy state', 2))).toBe(
      ApplicationResourceStatus.DEGRADED,
    );
    expect(haClusterStatus(cluster('Failing over', 2))).toBe(
      ApplicationResourceStatus.DEGRADED,
    );
    expect(haClusterStatus(null)).toBe(ApplicationResourceStatus.DEGRADED);
  });
});
