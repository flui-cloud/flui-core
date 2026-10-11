import { findSandboxStandIn } from './sandbox-stand-in';
import { exampleClusterBilling } from './sandbox-world-billing';
import {
  exampleClusterSnapshots,
  exampleClusterStorage,
  exampleClusterVariableSet,
  exampleClusterVariableSets,
  exampleOrphanedClaims,
} from './sandbox-world-cluster';
import { exampleClusterFirewall, exampleFirewalls } from './sandbox-world';
import { APPS, MACHINES } from './sandbox-world-core';
import { BURST_WORKER } from './sandbox-world-fleet';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');
const OWN = { id: 'guest-cluster', clusterId: 'guest-cluster' };

const num = (value: string): number => Number.parseFloat(value);
const sum = (values: string[]): number =>
  Math.round(values.reduce((total, v) => total + num(v), 0) * 1e4) / 1e4;

describe('the example cluster tabs', () => {
  it.each([
    ['GET', '/infrastructure/clusters/:id/storage'],
    ['GET', '/infrastructure/clusters/:id/storage/orphaned-claims'],
    ['GET', '/clusters/:clusterId/snapshots'],
    ['GET', '/firewalls/cluster/:clusterId'],
    ['GET', '/variables/clusters/:clusterId/namespaces/:namespace'],
    ['GET', '/variables/clusters/:clusterId/namespaces/:namespace/:name'],
    ['GET', '/infrastructure/clusters/:id/billing'],
  ])('answers %s %s from the example world', (verb, route) => {
    expect(findSandboxStandIn(verb, route, true)).toBeDefined();
  });

  it('answers with the cluster it was asked about', () => {
    expect(exampleClusterStorage(NOW, {}, OWN).clusterId).toBe(OWN.id);
    expect(exampleOrphanedClaims(NOW, {}, OWN).clusterId).toBe(OWN.id);
    expect(exampleClusterBilling(NOW, {}, OWN).clusterId).toBe(OWN.id);
    expect(exampleClusterFirewall(NOW, {}, OWN).clusterId).toBe(OWN.id);
  });

  describe('storage', () => {
    it('is ready, sized, and counts the claims of the example applications', () => {
      const storage = exampleClusterStorage(NOW, {}, OWN);
      expect(storage.status).toBe('READY');
      expect(storage.enabled).toBe(true);
      expect(storage.volume.sizeGb).toBeGreaterThan(storage.pvcs.requestedGb);
      expect(storage.volume.volumeId.startsWith('example-')).toBe(true);
      const projects = new Set(APPS.map((a) => `p-${a.project}`));
      for (const ns of Object.keys(storage.pvcs.byNamespace)) {
        expect(projects.has(ns)).toBe(true);
      }
      expect(
        Object.values(storage.pvcs.byNamespace).reduce((a, b) => a + b, 0),
      ).toBe(storage.pvcs.bound);
    });

    it('totals the abandoned claims it lists', () => {
      const report = exampleOrphanedClaims(NOW, {}, OWN);
      expect(report.totalBytes).toBe(
        report.claims.reduce((total, c) => total + c.requestedBytes, 0),
      );
      expect(report.claims.every((c) => c.reason.length > 0)).toBe(true);
    });

    it('keeps snapshots of the orders database', () => {
      const ordersDb = APPS.find((a) => a.slug === 'orders-db')!;
      const snapshots = exampleClusterSnapshots(NOW);
      expect(snapshots.length).toBeGreaterThan(0);
      for (const snap of snapshots) {
        expect(snap.appId).toBe(ordersDb.id);
        expect(snap.ready).toBe(true);
        expect(snap.exportId).toBeTruthy();
        expect(snap.sink).toBe('pvc-clone');
      }
    });
  });

  describe('firewall', () => {
    it('shows the applied rules the tab lists, the same ones the list names', () => {
      const firewall = exampleClusterFirewall(NOW, {}, OWN);
      const [listed] = exampleFirewalls(NOW);
      expect(firewall.lastAppliedRules.length).toBeGreaterThan(0);
      expect(firewall.lastAppliedRules).toEqual(listed.desiredRules);
      expect(firewall.desiredHash).toBe(firewall.lastAppliedHash);
      expect(firewall.reconciliationStatus).toBe('IN_SYNC');
      expect(firewall.hasDrift).toBe(false);
      expect(firewall.lastReconciliationAt).toBeTruthy();
      expect(firewall.hostLayer.appliedNodes).toBe(MACHINES.length);
    });
  });

  describe('variables', () => {
    it('shows plain values and only the names of sensitive keys', () => {
      const sets = exampleClusterVariableSets(
        NOW,
        { type: 'all' },
        {
          clusterId: OWN.id,
          namespace: 'default',
        },
      ) as Array<{
        type: string;
        keys: string[];
        data?: Record<string, string>;
      }>;
      const plain = sets.filter((s) => s.type === 'plain');
      const sensitive = sets.filter((s) => s.type === 'sensitive');
      expect(plain.length).toBeGreaterThan(0);
      expect(sensitive.length).toBeGreaterThan(0);
      for (const set of plain) {
        expect(Object.keys(set.data ?? {})).toEqual(set.keys);
      }
      for (const set of sensitive) {
        expect(set.keys.length).toBeGreaterThan(0);
        expect(set).not.toHaveProperty('data');
      }
    });

    it('opens a set by name, and a sensitive one still without values', () => {
      const params = {
        clusterId: OWN.id,
        namespace: 'default',
        name: 'northwind-shared-sensitive',
      };
      const sensitive = exampleClusterVariableSet(
        NOW,
        { type: 'sensitive' },
        params,
      );
      expect(sensitive).not.toBeNull();
      expect(sensitive).not.toHaveProperty('data');
      expect(
        exampleClusterVariableSet(
          NOW,
          { type: 'plain' },
          {
            ...params,
            name: 'northwind-shared',
          },
        ),
      ).toHaveProperty('data.LOG_LEVEL', 'info');
    });

    it('has nothing in any other namespace, the platform’s own included', () => {
      expect(
        exampleClusterVariableSets(
          NOW,
          {},
          {
            clusterId: OWN.id,
            namespace: 'flui-system',
          },
        ),
      ).toEqual([]);
    });
  });

  describe('pricing', () => {
    const billing = exampleClusterBilling(NOW, {}, OWN);
    const mtd = billing.monthToDate;

    it('adds up: each total is the sum of the lines under it', () => {
      for (const side of ['Net', 'Gross'] as const) {
        const b = mtd.breakdown;
        expect(num(mtd[`total${side}`])).toBeCloseTo(
          sum([b[`compute${side}`], b[`storage${side}`], b[`traffic${side}`]]),
          4,
        );
        expect(num(b[`compute${side}`])).toBeCloseTo(
          sum(mtd.nodes.map((n) => n[`cost${side}`])),
          4,
        );
        expect(num(b[`storage${side}`])).toBeCloseTo(
          sum(mtd.volumes.map((v) => v[`cost${side}`])),
          4,
        );
        for (const node of mtd.nodes) {
          expect(num(node[`cost${side}`])).toBeCloseTo(
            sum(node.segments.map((s) => s[`cost${side}`])),
            4,
          );
        }
        const f = billing.forecast;
        expect(num(f[`total${side}`])).toBeCloseTo(
          sum([
            f.breakdown[`compute${side}`],
            f.breakdown[`storage${side}`],
            f.breakdown[`traffic${side}`],
          ]),
          2,
        );
        const r = billing.runRate;
        expect(num(r[`monthly${side}`])).toBeCloseTo(
          sum([r.breakdown[`compute${side}`], r.breakdown[`storage${side}`]]),
          2,
        );
      }
    });

    it('prices the three machines of the example world, and the worker it gave back', () => {
      const active = mtd.nodes.filter((n) => n.status === 'active');
      expect(
        active.map((n) => n.serverName).sort((a, b) => a.localeCompare(b)),
      ).toEqual(MACHINES.map((m) => m.name).sort((a, b) => a.localeCompare(b)));
      expect(billing.runRate.activeNodes).toBe(MACHINES.length);
      const removed = mtd.nodes.filter((n) => n.status === 'terminated');
      expect(removed.map((n) => n.serverName)).toEqual([BURST_WORKER.name]);
      expect(mtd.volumes).toHaveLength(billing.runRate.activeVolumes);
    });

    it('never forecasts less than what is already spent', () => {
      expect(num(billing.forecast.totalNet)).toBeGreaterThanOrEqual(
        Math.floor(num(mtd.totalNet) * 100) / 100,
      );
      expect(billing.billingPeriod.elapsedHours).toBeLessThanOrEqual(
        billing.billingPeriod.totalHours,
      );
      expect(billing.vat.included).toBe(true);
    });

    it('leaves out a machine whose hours fell in an earlier month', () => {
      const earlyInMonth = Date.parse('2026-09-02T06:00:00.000Z');
      const names = exampleClusterBilling(
        earlyInMonth,
        {},
        OWN,
      ).monthToDate.nodes.map((n) => n.serverName);
      expect(names).not.toContain(BURST_WORKER.name);
    });
  });
});
