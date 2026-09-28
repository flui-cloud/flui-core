jest.mock('chalk', () => {
  const same = (text: string) => text;
  return {
    __esModule: true,
    default: {
      green: same,
      red: same,
      yellow: same,
      dim: same,
      bold: same,
      cyan: same,
    },
  };
});

import {
  UpgradeOperationView,
  UpgradePlanView,
  applyCommand,
  backupAcknowledgement,
  renderUpgradeOperation,
  renderUpgradePlan,
} from './platform-upgrade-view';

const ACK = 'Without a backup, a database migration cannot be undone.';

const plan = (over: Partial<UpgradePlanView> = {}): UpgradePlanView => ({
  planId: 'a1b2c3d4e5f60718',
  fromVersion: '0.19.0',
  targetVersion: '0.20.0',
  bootstrapRef: 'abc123',
  k3sVersion: 'v1.36.1+k3s1',
  migrations: 2,
  applicable: true,
  acknowledgement: ACK,
  advisories: [
    { level: 'warning', title: '2 database migration(s) will run', detail: '' },
  ],
  blockers: [],
  phases: [
    {
      key: 'backup',
      title: 'Back up the platform',
      willRun: true,
      summary: 'Runs the platform backup "platform".',
      blockers: [],
    },
    {
      key: 'manifests',
      title: 'Bring the system manifests forward',
      willRun: true,
      summary: 'control, work-1',
      blockers: [],
      clusters: [
        {
          clusterId: 'ctl',
          clusterName: 'control',
          clusterType: 'control',
          files: [{ name: '04c-vmalert.yaml', action: 'replace' }],
          upToDate: false,
          blockers: [],
        },
        {
          clusterId: 'w1',
          clusterName: 'work-1',
          clusterType: 'workload',
          files: [],
          upToDate: true,
          blockers: [],
        },
      ],
    },
    {
      key: 'images',
      title: 'Roll out the platform components',
      willRun: true,
      summary: 'Flui API 0.19.0 → 0.20.0',
      blockers: [],
    },
    {
      key: 'k3s',
      title: 'Upgrade K3s',
      willRun: true,
      summary: 'x',
      blockers: [],
      clusters: [
        {
          clusterId: 'w1',
          clusterName: 'work-1',
          clusterType: 'workload',
          fromVersion: 'v1.35.4+k3s1',
          steps: ['v1.36.1+k3s1'],
          upToDate: false,
          blockers: [],
        },
        {
          clusterId: 'ctl',
          clusterName: 'control',
          clusterType: 'control',
          fromVersion: 'v1.35.4+k3s1',
          steps: ['v1.36.1+k3s1'],
          upToDate: false,
          blockers: [],
        },
      ],
    },
    {
      key: 'verify',
      title: 'Verify',
      willRun: true,
      summary: 'checks',
      blockers: [],
    },
  ],
  ...over,
});

describe('flui env upgrade — the plan', () => {
  it('prints the phases in the order they run, numbered', () => {
    const text = renderUpgradePlan(plan()).join('\n');
    const order = [
      '1. Back up the platform',
      '2. Bring the system manifests forward',
      '3. Roll out the platform components',
      '4. Upgrade K3s',
      '5. Verify',
    ].map((t) => text.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('lists K3s workload clusters before the control', () => {
    const text = renderUpgradePlan(plan()).join('\n');
    const k3s = text.slice(text.indexOf('4. Upgrade K3s'));
    expect(k3s.indexOf('work-1')).toBeLessThan(k3s.indexOf('control'));
    expect(k3s).toContain('v1.35.4+k3s1 → v1.36.1+k3s1');
  });

  it('ends with the exact command that applies this plan', () => {
    const lines = renderUpgradePlan(plan());
    expect(lines.join('\n')).toContain(
      'flui env upgrade --to 0.20.0 --plan a1b2c3d4e5f60718 --apply',
    );
  });

  it('shows a missing backup as a blocker the acknowledgement passes, with the sentence', () => {
    const text = renderUpgradePlan(
      plan({
        blockers: [
          {
            phase: 'backup',
            message: 'No platform backup is set up.',
            overridable: true,
          },
        ],
      }),
    ).join('\n');
    expect(text).toContain('No platform backup is set up.');
    expect(text).toContain('--without-backup');
    expect(text).toContain(ACK);
  });

  it('says it cannot be applied when a hard blocker stands', () => {
    const text = renderUpgradePlan(
      plan({
        applicable: false,
        blockers: [{ phase: 'k3s', message: 'control: Node x is not Ready.' }],
      }),
    ).join('\n');
    expect(text).toContain('Node x is not Ready');
    expect(text).not.toContain('--apply');
  });

  it('narrows to one cluster when asked', () => {
    const text = renderUpgradePlan(plan(), { cluster: 'w1' }).join('\n');
    expect(text).toContain('work-1');
    expect(text).not.toContain('04c-vmalert.yaml');
  });

  it('builds the apply command with the backup skipped only when asked', () => {
    expect(applyCommand(plan(), true)).toBe(
      'flui env upgrade --to 0.20.0 --plan a1b2c3d4e5f60718 --apply --without-backup',
    );
  });
});

describe('flui env upgrade — the running update', () => {
  const op = (
    over: Partial<UpgradeOperationView> = {},
  ): UpgradeOperationView => ({
    id: 'op-1',
    status: 'IN_PROGRESS',
    fromVersion: '0.19.0',
    targetVersion: '0.20.0',
    schema: 2,
    awaitingSelfRestart: false,
    withoutBackup: false,
    errorMessage: null,
    guidance: null,
    phases: [
      { key: 'backup', title: 'Back up the platform', status: 'done' },
      {
        key: 'k3s',
        title: 'Upgrade K3s',
        status: 'running',
        clusters: [
          {
            clusterId: 'w1',
            clusterName: 'work-1',
            clusterType: 'workload',
            status: 'running',
            steps: ['v1.36.1+k3s1'],
            stepIndex: 0,
            nodes: [
              {
                name: 'w1-master',
                role: 'server',
                fromVersion: 'v1.35.4+k3s1',
                version: 'v1.35.4+k3s1',
                status: 'upgrading',
              },
            ],
          },
        ],
      },
    ],
    ...over,
  });

  it('shows each node of the cluster K3s is on', () => {
    const text = renderUpgradeOperation(op()).join('\n');
    expect(text).toContain('w1-master');
    expect(text).toContain('upgrading');
  });

  it('prints the fixed guidance and the resume hint after a failure', () => {
    const text = renderUpgradeOperation(
      op({
        status: 'FAILED',
        errorMessage: 'work-1: node failed',
        guidance: 'K3s is never downgraded.',
      }),
    ).join('\n');
    expect(text).toContain('K3s is never downgraded.');
    expect(text).toContain('flui env upgrade --resume op-1');
  });
});

describe('going without a backup', () => {
  const SENTENCE = 'Without a backup, a database migration cannot be undone.';
  const never = async (): Promise<string> => {
    throw new Error('asked');
  };

  it('asks for nothing when the backup is taken', async () => {
    await expect(
      backupAcknowledgement({
        withoutBackup: false,
        canAsk: false,
        ask: never,
      }),
    ).resolves.toEqual({});
  });

  it('never supplies the sentence itself', async () => {
    const result = await backupAcknowledgement({
      withoutBackup: true,
      canAsk: false,
      ask: never,
    });
    expect(result.acknowledgement).toBeUndefined();
    expect(result.error).toContain('--acknowledge');
  });

  it('takes the sentence given with --acknowledge, and only that sentence', async () => {
    await expect(
      backupAcknowledgement({
        withoutBackup: true,
        acknowledge: SENTENCE,
        canAsk: false,
        ask: never,
      }),
    ).resolves.toEqual({ acknowledgement: SENTENCE });
    const wrong = await backupAcknowledgement({
      withoutBackup: true,
      acknowledge: 'yes',
      canAsk: true,
      ask: never,
    });
    expect(wrong.acknowledgement).toBeUndefined();
    expect(wrong.error).toBeDefined();
  });

  it('asks the person to type it when there is a terminal', async () => {
    const typed = await backupAcknowledgement({
      withoutBackup: true,
      canAsk: true,
      ask: async () => SENTENCE,
    });
    expect(typed).toEqual({ acknowledgement: SENTENCE });
    const mistyped = await backupAcknowledgement({
      withoutBackup: true,
      canAsk: true,
      ask: async () => 'ok',
    });
    expect(mistyped.error).toBeDefined();
  });
});
