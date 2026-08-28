import { DrainPod, DrainSubject, checkDrain, drainSummary } from './drain.core';

const pod = (over: Partial<DrainPod> = {}): DrainPod => ({
  name: 'checkout-7d8f',
  namespace: 'flui-apps',
  ownerKind: 'ReplicaSet',
  mirror: false,
  boundVolumes: [],
  labels: { app: 'checkout' },
  ...over,
});

const subject = (over: Partial<DrainSubject> = {}): DrainSubject => ({
  nodeName: 'prod-eu-worker-2',
  isMaster: false,
  dedicatedApps: [],
  pods: [pod()],
  budgets: [],
  ...over,
});

describe('whether a node can be emptied', () => {
  it('clears a node whose pods all have somewhere else to go', () => {
    const check = checkDrain(subject());
    expect(check.ok).toBe(true);
    expect(check.blockers).toHaveLength(0);
  });

  it('lists what passed, so a yes is something a person can check', () => {
    const check = checkDrain(subject());
    expect(check.cleared.length).toBeGreaterThan(0);
  });

  it('refuses the master by what it is, without counting a single pod', () => {
    const check = checkDrain(subject({ isMaster: true, pods: [] }));
    expect(check.ok).toBe(false);
    expect(check.blockers[0]).toMatchObject({ kind: 'is-master' });
  });

  it('refuses a machine an application keeps its data on, and names it', () => {
    const check = checkDrain(subject({ dedicatedApps: ['postgres-main'] }));
    expect(check.ok).toBe(false);
    expect(check.blockers[0]).toMatchObject({
      kind: 'dedicated-app',
      what: 'postgres-main',
    });
  });

  it('refuses a bare pod: nothing would put it back anywhere', () => {
    const check = checkDrain(subject({ pods: [pod({ ownerKind: null })] }));
    expect(check.blockers[0].kind).toBe('no-controller');
  });

  it('refuses a pod holding a volume that lives on this machine', () => {
    const check = checkDrain(
      subject({ pods: [pod({ boundVolumes: ['data-checkout-0'] })] }),
    );
    expect(check.blockers[0]).toMatchObject({ kind: 'bound-volume' });
    expect(check.blockers[0].what).toContain('data-checkout-0');
  });

  it('refuses where a disruption budget permits nothing', () => {
    const check = checkDrain(
      subject({
        budgets: [
          {
            namespace: 'flui-apps',
            name: 'checkout-pdb',
            selector: { app: 'checkout' },
            disruptionsAllowed: 0,
          },
        ],
      }),
    );
    expect(check.blockers[0]).toMatchObject({ kind: 'disruption-budget' });
  });

  it('reads an empty selector as covering the namespace, not as covering nothing', () => {
    const check = checkDrain(
      subject({
        budgets: [
          {
            namespace: 'flui-apps',
            name: 'freeze',
            selector: {},
            disruptionsAllowed: 0,
          },
        ],
      }),
    );
    expect(check.ok).toBe(false);
  });

  it('leaves a budget that has not been evaluated out of the way', () => {
    const check = checkDrain(
      subject({
        budgets: [
          {
            namespace: 'flui-apps',
            name: 'checkout-pdb',
            selector: { app: 'checkout' },
            disruptionsAllowed: null,
          },
        ],
      }),
    );
    expect(check.ok).toBe(true);
  });

  it('does not let a budget in another namespace block a pod it cannot cover', () => {
    const check = checkDrain(
      subject({
        budgets: [
          {
            namespace: 'kube-system',
            name: 'coredns',
            selector: { app: 'checkout' },
            disruptionsAllowed: 0,
          },
        ],
      }),
    );
    expect(check.ok).toBe(true);
  });

  it('neither evicts a DaemonSet pod nor counts it against the drain', () => {
    const check = checkDrain(
      subject({
        pods: [pod({ ownerKind: 'DaemonSet', boundVolumes: ['/var/log'] })],
      }),
    );
    expect(check.ok).toBe(true);
    expect(check.cleared.join(' ')).toContain('DaemonSet');
  });

  it('refuses a static pod, which is placed by the machine and cannot be evicted', () => {
    const check = checkDrain(
      subject({ pods: [pod({ mirror: true, ownerKind: null })] }),
    );
    expect(check.blockers).toHaveLength(1);
    expect(check.blockers[0].kind).toBe('not-evictable');
  });

  it('summarises into what stands in the way and what would clear it', () => {
    const check = checkDrain(subject({ dedicatedApps: ['postgres-main'] }));
    const line = drainSummary(check);
    expect(line).toContain('postgres-main');
    expect(line).toContain('redeploy');
  });
});
