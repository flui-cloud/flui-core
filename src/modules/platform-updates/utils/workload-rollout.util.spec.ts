import { rolloutOf } from './workload-rollout.util';

const meta = (generation = 2) => ({ metadata: { generation } });

describe('rolloutOf', () => {
  it('is not ready while the object does not exist', () => {
    expect(rolloutOf('StatefulSet', null)).toEqual({
      ready: false,
      detail: 'not created yet',
    });
  });

  it('waits for a StatefulSet pod that cannot be scheduled', () => {
    const postgres = {
      ...meta(),
      spec: { replicas: 1 },
      status: {
        observedGeneration: 2,
        readyReplicas: 0,
        currentRevision: 'postgres-a',
        updateRevision: 'postgres-b',
      },
    };
    expect(rolloutOf('StatefulSet', postgres)).toEqual({
      ready: false,
      detail: '0/1 ready',
    });
  });

  it('accepts a StatefulSet on its new revision with every replica ready', () => {
    const postgres = {
      ...meta(),
      spec: { replicas: 1 },
      status: {
        observedGeneration: 2,
        readyReplicas: 1,
        currentRevision: 'postgres-b',
        updateRevision: 'postgres-b',
      },
    };
    expect(rolloutOf('StatefulSet', postgres).ready).toBe(true);
  });

  it('does not trust a status the controller has not caught up with', () => {
    const api = {
      ...meta(3),
      spec: { replicas: 1 },
      status: {
        observedGeneration: 2,
        updatedReplicas: 1,
        availableReplicas: 1,
      },
    };
    expect(rolloutOf('Deployment', api).ready).toBe(false);
  });

  it('needs a Deployment updated and available', () => {
    const base = { ...meta(), spec: { replicas: 2 } };
    expect(
      rolloutOf('Deployment', {
        ...base,
        status: {
          observedGeneration: 2,
          updatedReplicas: 2,
          availableReplicas: 1,
        },
      }).ready,
    ).toBe(false);
    expect(
      rolloutOf('Deployment', {
        ...base,
        status: {
          observedGeneration: 2,
          updatedReplicas: 2,
          availableReplicas: 2,
        },
      }),
    ).toEqual({ ready: true, detail: '2/2 available, 2 updated' });
  });

  it('needs a DaemonSet updated and available on every node it wants', () => {
    const traefik = (available: number) => ({
      ...meta(),
      status: {
        observedGeneration: 2,
        desiredNumberScheduled: 2,
        updatedNumberScheduled: 2,
        numberAvailable: available,
      },
    });
    expect(rolloutOf('DaemonSet', traefik(1)).ready).toBe(false);
    expect(rolloutOf('DaemonSet', traefik(2)).ready).toBe(true);
  });

  it('counts a workload scaled to zero as rolled out', () => {
    expect(
      rolloutOf('Deployment', { ...meta(), spec: { replicas: 0 }, status: {} })
        .ready,
    ).toBe(true);
  });
});
