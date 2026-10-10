jest.mock('@kubernetes/client-node', () => ({}));

import {
  includedMonthlyTrafficTb,
  trafficWatchConfigFrom,
} from './traffic-watch.config';
import {
  fingerprintOf,
  findingsFor,
  TrafficReading,
  TrafficWatchService,
} from './traffic-watch.service';

const config = trafficWatchConfigFrom(() => undefined);
const quiet: TrafficReading = {
  measuredAt: new Date(),
  nodes: [
    {
      clusterId: 'c1',
      node: 'n1',
      mbpsOut: 20,
      mbpsIn: 5,
      monthPaceBytes: 2e12,
      includedTb: 20,
    },
  ],
  edges: [
    {
      clusterId: 'c1',
      rpsNow: 2,
      rpsBefore: 1.5,
      rateLimited10m: 0,
      requests10m: 1200,
      serverErrors10m: 3,
    },
  ],
};
const names = (r: TrafficReading, c = config) =>
  findingsFor(r, c).map((f) => f.alertname);

describe('watching traffic for the launch', () => {
  it('says nothing on an ordinary day', () => {
    expect(names(quiet)).toEqual([]);
  });

  it('notices a node link that stays busy, in either direction', () => {
    const busy = { ...quiet, nodes: [{ ...quiet.nodes[0], mbpsIn: 640 }] };
    const [finding] = findingsFor(busy, config);
    expect(finding).toMatchObject({
      alertname: 'FluiNodeBandwidthHigh',
      fingerprint: fingerprintOf('bandwidth', 'c1', 'n1'),
      fluiKind: 'node',
      clusterId: 'c1',
      nodeInstance: 'n1',
    });
  });

  it('warns when the pace of the month heads past what the provider includes', () => {
    const heavy = {
      ...quiet,
      nodes: [{ ...quiet.nodes[0], monthPaceBytes: 17e12 }],
    };
    expect(names(heavy)).toEqual(['FluiNodeMonthlyTrafficHigh']);
    const unmetered = {
      ...quiet,
      nodes: [{ ...quiet.nodes[0], monthPaceBytes: 99e12, includedTb: null }],
    };
    expect(names(unmetered)).toEqual([]);
  });

  it('calls a surge only above a floor, so a quiet site waking up is not one', () => {
    const waking = {
      ...quiet,
      edges: [{ ...quiet.edges[0], rpsNow: 3, rpsBefore: 0.1 }],
    };
    expect(names(waking)).toEqual([]);
    const surge = {
      ...quiet,
      edges: [{ ...quiet.edges[0], rpsNow: 40, rpsBefore: 4 }],
    };
    expect(names(surge)).toEqual(['FluiTrafficSurge']);
  });

  it('tells about people turned away by a rate limit, and about server errors once there are enough requests', () => {
    const bad = {
      ...quiet,
      edges: [{ ...quiet.edges[0], rateLimited10m: 25, serverErrors10m: 90 }],
    };
    const findings = findingsFor(bad, config);
    expect(findings.map((f) => [f.alertname, f.severity])).toEqual([
      ['FluiRequestsRateLimited', 'warning'],
      ['FluiEdgeServerErrors', 'critical'],
    ]);
    const few = {
      ...quiet,
      edges: [{ ...quiet.edges[0], requests10m: 20, serverErrors10m: 10 }],
    };
    expect(names(few)).toEqual([]);
  });

  it('takes every threshold from the environment, and 0 turns one off', () => {
    const c = trafficWatchConfigFrom(
      (k) =>
        ({
          FLUI_ALERT_NODE_MBPS: '0',
          FLUI_ALERT_INCLUDED_TRAFFIC_TB: '2',
          FLUI_ALERT_PUBLIC_INTERFACES: 'ens3',
        })[k],
    );
    expect(c).toMatchObject({
      nodeMbps: 0,
      includedTrafficTb: 2,
      publicInterfaces: 'ens3',
    });
    const busy = { ...quiet, nodes: [{ ...quiet.nodes[0], mbpsOut: 900 }] };
    expect(names(busy, c)).toEqual([]);
  });

  it('keeps every fingerprint within what the recorder stores, however long the names', () => {
    const fp = fingerprintOf(
      'bandwidth',
      '23080e08-df4e-4234-b0b2-acc69f629110',
      'control-cluster-staging-hz-worker-1',
    );
    expect(fp.length).toBeLessThanOrEqual(64);
    expect(fp.startsWith('flui-traffic:bandwidth:')).toBe(true);
  });

  it('knows what each provider includes, and nothing it does not', () => {
    expect(includedMonthlyTrafficTb('hetzner', 'fsn1')).toBe(20);
    expect(includedMonthlyTrafficTb('hetzner', 'ash')).toBe(1);
    expect(includedMonthlyTrafficTb('hetzner', 'sin')).toBe(0.5);
    expect(includedMonthlyTrafficTb('contabo', 'eu')).toBe(32);
    expect(includedMonthlyTrafficTb('scaleway', 'fr-par')).toBeNull();
    expect(includedMonthlyTrafficTb('ovh', 'gra')).toBeNull();
  });
});

describe('raising and closing them', () => {
  const run = async (open: Map<string, Date>, reading: TrafficReading) => {
    const recorded: Array<Record<string, any>> = [];
    const delivered: string[] = [];
    const service = new TrafficWatchService(
      { get: () => undefined } as never,
      {} as never,
      {
        openEpisodes: async () => open,
        record: async (alerts: Array<Record<string, any>>) => {
          recorded.push(...alerts);
          return alerts.map((a) => ({
            kind: a.status === 'firing' ? 'fired' : 'resolved',
            event: a,
          }));
        },
      } as never,
      {
        deliver: async (kind: string) => {
          delivered.push(kind);
        },
      } as never,
      {} as never,
    );
    jest.spyOn(service, 'read').mockResolvedValue(reading);
    await service.tick();
    return { recorded, delivered };
  };

  it('keeps an episode going with its first start, and closes what no longer holds', async () => {
    const since = new Date('2026-10-09T10:00:00Z');
    const busy = { ...quiet, nodes: [{ ...quiet.nodes[0], mbpsOut: 700 }] };
    const { recorded } = await run(
      new Map([
        [fingerprintOf('bandwidth', 'c1', 'n1'), since],
        [fingerprintOf('surge', 'c1'), since],
      ]),
      busy,
    );
    expect(recorded.map((r) => [r.fingerprint, r.status, r.startsAt])).toEqual([
      [fingerprintOf('bandwidth', 'c1', 'n1'), 'firing', since],
      [fingerprintOf('surge', 'c1'), 'resolved', since],
    ]);
    expect(recorded[1].alertname).toBe('FluiTrafficSurge');
    expect(recorded[1].annotations.summary).toBe(
      'Requests are back to their usual pace',
    );
  });

  it('records nothing on a quiet day with nothing open', async () => {
    const { recorded } = await run(new Map(), quiet);
    expect(recorded).toEqual([]);
  });
});
