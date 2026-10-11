import { findSandboxStandIn, isStandInArea } from './sandbox-stand-in';
import {
  exampleClusterScalingDecisions,
  exampleScalingDecisions,
} from './sandbox-world-scaling-decisions';
import {
  exampleScalingCatalogue,
  exampleScalingGroup,
  exampleScalingPreview,
  exampleScalingRow,
  exampleScalingRows,
  SCALING_GROUP_ID,
} from './sandbox-world-scaling';
import {
  exampleClusterNodes,
  exampleFleetHistory,
} from './sandbox-world-scaling-fleet';
import { exampleClusterBilling } from './sandbox-world-billing';
import { CLUSTER_ID, CLUSTER_NAME, MACHINES } from './sandbox-world-core';
import { BURST_WORKER } from './sandbox-world-fleet';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

const DECISION_OUTCOMES = [
  'added',
  'replaced',
  'removed',
  'declined',
  'alerted',
  'changed',
  'node-ordered',
  'node-joined',
  'purchase-failed',
  'node-drained',
  'node-removed',
];

describe('the example scaling group', () => {
  it.each([
    '/infrastructure/scaling',
    '/infrastructure/clusters/:clusterId/scaling',
    '/infrastructure/clusters/:clusterId/scaling-decisions',
    '/infrastructure/scaling-groups/:id',
    '/infrastructure/scaling-groups/:id/preview',
    '/infrastructure/scaling-groups/:id/decisions',
    '/infrastructure/scaling-groups/:id/catalogue',
    '/infrastructure/clusters/:id/fleet/history',
  ])('answers GET %s from the example world', (route) => {
    expect(findSandboxStandIn('GET', route, true)).toBeDefined();
  });

  it('lists the example cluster and nothing else', () => {
    const rows = exampleScalingRows(NOW);
    expect(rows).toHaveLength(1);
    expect(rows.map((r) => r.clusterId)).toEqual([CLUSTER_ID]);
    expect(rows[0].clusterName).toBe(CLUSTER_NAME);
    expect(rows[0].groupId).toBe(SCALING_GROUP_ID);
  });

  it('answers the scaling tab of the cluster it was asked about', () => {
    const row = exampleScalingRow(NOW, {}, { clusterId: 'guest-cluster' });
    expect(row.clusterId).toBe('guest-cluster');
    expect(row.groupId).toBe(SCALING_GROUP_ID);
  });

  it('holds nothing that asks a person to act', () => {
    const row = exampleScalingRow(NOW);
    expect(row.needsPerson).toBeNull();
    expect(row.openAlarm).toBeNull();
    expect(row.nodes).toBeGreaterThanOrEqual(row.bounds.min);
    expect(row.nodes).toBeLessThanOrEqual(row.bounds.max);
    expect(row.monthlyEur).toBeLessThanOrEqual(row.monthlyCap);
    const group = exampleScalingGroup(NOW)!;
    expect(group.purchase).toBeNull();
    expect(group.purchaseHeld).toBeNull();
    expect(typeof group.acts.says).toBe('string');
    expect(group.acts.acts).toBe(true);
    const preview = exampleScalingPreview()!;
    expect(preview.pending).toBeNull();
    expect(preview.giveBack).toBeNull();
    expect(preview.blocked).toBeNull();
  });

  it('prices the fleet the bill prices, and counts the machines the fleet lists', () => {
    const row = exampleScalingRow(NOW);
    const billing = exampleClusterBilling(NOW);
    expect(row.monthlyEur).toBeCloseTo(
      Number.parseFloat(billing.runRate.breakdown.computeNet),
      2,
    );
    expect(row.nodes).toBe(MACHINES.length);
    expect(exampleClusterNodes(NOW).map((n) => n.serverName)).toEqual(
      MACHINES.map((m) => m.name),
    );
  });

  it('decides only in words the history knows, newest first', () => {
    const decisions = exampleScalingDecisions(NOW, { limit: '50' });
    for (const d of decisions) {
      expect(DECISION_OUTCOMES).toContain(d.outcome);
    }
    const times = decisions.map((d) => Date.parse(d.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(
      decisions.filter((d) => d.did.includes(BURST_WORKER.name)).length,
    ).toBeGreaterThan(0);
  });

  it('filters and limits the way the page asks', () => {
    const nodes = exampleScalingDecisions(NOW, { outcome: 'nodes' });
    expect(nodes.every((d) => d.outcome.startsWith('node-'))).toBe(true);
    expect(exampleScalingDecisions(NOW, { limit: '2' })).toHaveLength(2);
    expect(
      exampleClusterScalingDecisions(NOW, { limit: '5' }).every(
        (d) => d.groupId === SCALING_GROUP_ID,
      ),
    ).toBe(true);
  });

  it('answers to its own group id only', () => {
    expect(exampleScalingGroup(NOW, {}, { id: 'someone-else' })).toBeNull();
    expect(exampleScalingDecisions(NOW, {}, { id: 'someone-else' })).toEqual(
      [],
    );
    expect(
      exampleScalingCatalogue(NOW, {}, { id: SCALING_GROUP_ID }),
    ).not.toBeNull();
  });

  it('draws the fleet history over the window it was asked for', () => {
    const day = exampleFleetHistory(NOW, { hours: '24', stepMinutes: '15' });
    expect(day.stepSeconds).toBe(900);
    expect(day.points.length).toBeGreaterThan(90);
    const week = exampleFleetHistory(NOW, { days: '7', stepHours: '2' });
    const peak = Math.max(...week.points.map((p) => p.nodes));
    expect(peak).toBe(MACHINES.length + 1);
    expect(week.points.at(-1)?.nodes).toBe(MACHINES.length);
  });

  describe('the example cluster', () => {
    it('answers its nodes from the example world, and nobody else’s', () => {
      const route = '/infrastructure/clusters/:id/nodes';
      expect(
        findSandboxStandIn('GET', route, true, { id: CLUSTER_ID }),
      ).toBeDefined();
      expect(
        findSandboxStandIn('GET', route, true, { id: 'guest-cluster' }),
      ).toBeUndefined();
      expect(findSandboxStandIn('GET', route, true)).toBeUndefined();
    });

    it('leaves the guest’s own nodes a section shown for real', () => {
      expect(
        isStandInArea('/infrastructure/clusters/:id/nodes/:nodeId/scale', true),
      ).toBe(false);
    });
  });
});
