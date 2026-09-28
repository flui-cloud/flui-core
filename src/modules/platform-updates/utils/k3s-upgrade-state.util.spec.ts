import {
  allNodesAt,
  assessK3sCluster,
  initialK3sState,
  nodeStates,
  oldestK3sVersion,
} from './k3s-upgrade-state.util';
import { AGENT_PLAN, SERVER_PLAN, jobVersionLabel } from './k3s-plans.util';

const node = (name: string, kubeletVersion: string | null, ready = true) => ({
  name,
  server: name.startsWith('s'),
  kubeletVersion,
  ready,
});
const controller = { installed: true, ready: true };

describe('reading the K3s versions of a cluster', () => {
  it('starts the path from the oldest node, as the node reports it', () => {
    expect(
      oldestK3sVersion([
        node('s1', 'v1.33.4+k3s1'),
        node('a1', 'v1.32.9+k3s1'),
        node('a2', 'garbage'),
      ]),
    ).toBe('v1.32.9+k3s1');
  });

  it('is at a step only when every node reports it or newer', () => {
    const nodes = [node('s1', 'v1.33.4+k3s1'), node('a1', 'v1.32.9+k3s1')];
    expect(allNodesAt(nodes, 'v1.32.9+k3s1')).toBe(true);
    expect(allNodesAt(nodes, 'v1.33.4+k3s1')).toBe(false);
  });
});

describe('assessing a cluster', () => {
  it('is up to date with nothing to do and nothing in the way', () => {
    const plan = assessK3sCluster(
      { nodes: [node('s1', 'v1.33.4+k3s1')], controller },
      'v1.33.4+k3s1',
      [],
    );
    expect(plan).toMatchObject({ upToDate: true, steps: [], blockers: [] });
    expect(plan.nodes).toEqual([
      {
        name: 's1',
        role: 'server',
        kubeletVersion: 'v1.33.4+k3s1',
        ready: true,
      },
    ]);
  });

  it('says why an unreadable cluster cannot be planned, and no more', () => {
    const plan = assessK3sCluster(
      {
        nodes: [],
        controller: { installed: false, ready: false },
        readError: 'timeout',
      },
      'v1.33.4+k3s1',
      [],
    );
    expect(plan.upToDate).toBe(false);
    expect(plan.blockers).toEqual([
      "The cluster's API could not be read: timeout",
    ]);
  });

  it('names an unreadable version, a node that is not Ready and a missing controller', () => {
    const plan = assessK3sCluster(
      {
        nodes: [node('s1', 'nonsense'), node('a1', 'v1.33.4+k3s1', false)],
        controller: { installed: false, ready: false },
      },
      'v1.33.4+k3s1',
      [],
    );
    expect(plan.blockers).toEqual([
      'Node s1 reports K3s "nonsense", which cannot be read.',
      'Node a1 is not Ready; it would never finish an upgrade.',
      expect.stringContaining('system-upgrade-controller is not installed'),
    ]);
  });
});

describe('the state of an upgrade', () => {
  it('starts every node pending from the version it reports', () => {
    const state = initialK3sState(
      {
        clusterId: 'c',
        clusterName: 'c',
        clusterType: 'workload',
        recordedVersion: null,
        observedVersion: 'v1.32.9+k3s1',
        targetVersion: 'v1.33.4+k3s1',
        steps: ['v1.33.4+k3s1'],
        nodes: [
          {
            name: 'a1',
            role: 'agent',
            kubeletVersion: 'v1.32.9+k3s1',
            ready: true,
          },
        ],
        controller,
        upToDate: false,
        blockers: [],
      },
      'c',
      'v1.33.4+k3s1',
      '2026-01-01T00:00:00.000Z',
    );
    expect(state).toMatchObject({
      stepIndex: 0,
      status: 'running',
      nodes: [
        {
          name: 'a1',
          fromVersion: 'v1.32.9+k3s1',
          version: 'v1.32.9+k3s1',
          status: 'pending',
        },
      ],
    });
  });

  it('reads each node from its kubelet first, then from its newest Job', () => {
    const step = 'v1.33.4+k3s1';
    const job = (name: string, nodeName: string, extra = {}) => ({
      name,
      plan: nodeName.startsWith('s') ? SERVER_PLAN : AGENT_PLAN,
      node: nodeName,
      version: jobVersionLabel(step),
      active: false,
      failed: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...extra,
    });
    const states = nodeStates(
      [],
      {
        nodes: [
          node('s1', step),
          node('a1', 'v1.32.9+k3s1'),
          node('a2', 'v1.32.9+k3s1'),
          node('a3', 'v1.32.9+k3s1'),
        ],
        jobs: [
          job('j1', 'a1', { active: true }),
          job('j2-old', 'a2', { active: true }),
          job('j2', 'a2', {
            failed: true,
            message: 'drain timed out',
            createdAt: '2026-01-02T00:00:00.000Z',
          }),
        ],
      },
      step,
    );
    expect(states.map((s) => [s.name, s.status, s.job])).toEqual([
      ['s1', 'done', undefined],
      ['a1', 'upgrading', 'j1'],
      ['a2', 'failed', 'j2'],
      ['a3', 'pending', undefined],
    ]);
  });
});
