jest.mock('@kubernetes/client-node', () => ({}));

import {
  ManifestRolloutGuard,
  RolloutFailedError,
  WrittenPlan,
} from './manifest-rollout.guard';

const POSTGRES = `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: flui-system
spec:
  replicas: 1
`;
const PRIORITY = `apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: flui-platform
`;

const readyPostgres = {
  metadata: { generation: 2 },
  spec: { replicas: 1 },
  status: {
    observedGeneration: 2,
    readyReplicas: 1,
    currentRevision: 'b',
    updateRevision: 'b',
  },
};
const pendingPostgres = {
  ...readyPostgres,
  status: { ...readyPostgres.status, readyReplicas: 0, currentRevision: 'a' },
};

function setup(read: () => unknown, restore?: () => Promise<string[]>) {
  const kube = { readObject: jest.fn(async () => read()) };
  const master = {
    restore: jest.fn(
      restore ??
        (async () => ['RESTORED 02-postgres.yaml', 'REMOVED 01b.yaml']),
    ),
  };
  const guard = new ManifestRolloutGuard(kube as never, master as never);
  let clock = 0;
  guard.now = () => clock;
  guard.sleep = async (ms) => {
    clock += ms;
  };
  const plan: WrittenPlan = {
    kubeconfig: 'kc',
    node: 'master-0',
    planId: 'abc123',
    contents: new Map([
      ['02-postgres.yaml', POSTGRES],
      ['01b.yaml', PRIORITY],
    ]),
  };
  return { guard, kube, master, plan, elapsed: () => clock };
}

const WAIT = { timeoutMs: 300_000, settleMs: 30_000 };

describe('ManifestRolloutGuard', () => {
  it('returns at once when the written files hold no workload', async () => {
    const { guard, kube, plan, elapsed } = setup(() => readyPostgres);
    await guard.await(plan, ['01b.yaml'], WAIT);
    expect(kube.readObject).not.toHaveBeenCalled();
    expect(elapsed()).toBe(0);
  });

  it('waits out the settle time before calling a workload rolled out', async () => {
    const { guard, kube, master, plan, elapsed } = setup(() => readyPostgres);
    await guard.await(plan, ['02-postgres.yaml', '01b.yaml'], WAIT);
    expect(elapsed()).toBeGreaterThanOrEqual(WAIT.settleMs);
    expect(kube.readObject).toHaveBeenCalledWith(
      'kc',
      'apps/v1',
      'StatefulSet',
      'postgres',
      'flui-system',
    );
    expect(master.restore).not.toHaveBeenCalled();
  });

  it('keeps waiting while the pod cannot start, then succeeds once it does', async () => {
    let reads = 0;
    const { guard, master, plan } = setup(() =>
      ++reads < 20 ? pendingPostgres : readyPostgres,
    );
    await guard.await(plan, ['02-postgres.yaml'], WAIT);
    expect(reads).toBeGreaterThanOrEqual(20);
    expect(master.restore).not.toHaveBeenCalled();
  });

  it('puts the files back and fails when the workload never comes back', async () => {
    const { guard, master, plan, elapsed } = setup(() => pendingPostgres);
    const failure = guard.await(plan, ['02-postgres.yaml', '01b.yaml'], WAIT);
    await expect(failure).rejects.toBeInstanceOf(RolloutFailedError);
    await expect(failure).rejects.toThrow(
      'StatefulSet flui-system/postgres (0/1 ready) did not come back within 5 minutes after the manifests were written; the files were put back: RESTORED 02-postgres.yaml, REMOVED 01b.yaml.',
    );
    expect(master.restore).toHaveBeenCalledWith('kc', 'master-0', 'abc123', [
      '02-postgres.yaml',
      '01b.yaml',
    ]);
    expect(elapsed()).toBeGreaterThanOrEqual(WAIT.timeoutMs);
  });

  it('says where the previous files are when putting them back fails', async () => {
    const { guard, plan } = setup(
      () => null,
      async () => {
        throw new Error('lock held');
      },
    );
    await expect(guard.await(plan, ['02-postgres.yaml'], WAIT)).rejects.toThrow(
      'StatefulSet flui-system/postgres (not created yet) did not come back within 5 minutes after the manifests were written; the files were not put back (lock held); the previous files are in /var/lib/rancher/k3s/server/flui-refresh-backup/abc123.',
    );
  });
});
