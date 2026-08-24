// Pulled in transitively and ship ESM that jest won't parse; unused on this path.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import {
  DnsZoneReconciliationService,
  clusterWildcardRecord,
  sandboxWildcardRecord,
} from './dns-zone-reconciliation.service';
import {
  DnsRecordInfo,
  DnsRecordType,
} from '../../providers/interfaces/dns-provider.interface';

/**
 * A cluster publishes every one of its applications at
 * `<slug>.<cluster>.<zone>`, always at the same address. One wildcard record
 * covers all of them — including the ones that do not exist yet, which is the
 * whole point: a name that already resolves needs no propagation, and that
 * minute was landing on the screen with the link to the application on it.
 */

const zone = {
  id: 'zone-1',
  zoneName: 'dawit.blog',
  providerZoneId: 'pz-1',
  dnsProvider: 'hetzner',
  recordTtlSeconds: 300,
} as never;

const assignment = (over: Partial<{ name: string; ip: string | null }> = {}) =>
  ({
    id: 'assignment-1',
    cluster: {
      name: over.name ?? 'control-cluster',
      masterIpAddress: 'ip' in over ? over.ip : '109.123.252.6',
    },
    endpoints: [],
  }) as never;

/** An installation that never configured a sandbox subdomain — today's default. */
const sandboxOff = {
  isEnabled: () => false,
  label: () => 'demo',
  sandboxClusterId: () => null,
  ownsCluster: () => false,
} as never;

/** One that did, on the cluster the assignments below belong to. */
const sandboxOn = (label = 'demo') =>
  ({
    isEnabled: () => true,
    label: () => label,
    sandboxClusterId: () => 'c-sandbox',
    ownsCluster: (clusterId: string) => clusterId === 'c-sandbox',
  }) as never;

describe('the record a cluster needs on its zone', () => {
  it('covers every application the cluster will ever publish', () => {
    expect(clusterWildcardRecord(assignment(), zone)).toEqual({
      name: '*.control-cluster',
      type: DnsRecordType.A,
      value: '109.123.252.6',
      ttl: 300,
    });
  });

  /**
   * Scoped to the cluster's own subdomain, never the zone root: a zone shared
   * with a website and a mail server must be untouched outside `*.<cluster>`.
   */
  it('never reaches outside the cluster’s own subdomain', () => {
    const record = clusterWildcardRecord(assignment({ name: 'prod' }), zone);
    expect(record?.name).toBe('*.prod');
    expect(record?.name).not.toBe('*');
  });

  it('is nothing at all until the cluster has an address', () => {
    expect(clusterWildcardRecord(assignment({ ip: null }), zone)).toBeNull();
  });
});

describe('DnsZoneReconciliationService.ensureClusterWildcardRecord', () => {
  const build = (records: DnsRecordInfo[]) => {
    const createRecord = jest.fn().mockResolvedValue({});
    const updateRecord = jest.fn().mockResolvedValue({});
    const provider = {
      listRecords: jest.fn().mockResolvedValue(records),
      createRecord,
      updateRecord,
    };
    const service = new DnsZoneReconciliationService(
      null as never,
      null as never,
      null as never,
      { getDnsProviderOrFail: () => provider } as never,
      sandboxOff,
    );
    return { service, createRecord, updateRecord };
  };

  const existing = (value: string): DnsRecordInfo => ({
    recordId: 'r-1',
    zoneId: 'pz-1',
    type: DnsRecordType.A,
    name: '*.control-cluster',
    value,
    ttl: 300,
  });

  it('publishes the wildcard when the zone does not have one', async () => {
    const { service, createRecord } = build([]);

    await expect(
      service.ensureClusterWildcardRecord(assignment(), zone),
    ).resolves.toMatchObject({
      status: 'published',
      fqdn: '*.control-cluster.dawit.blog',
      hostnamePattern: '<application>.control-cluster.dawit.blog',
    });
    expect(createRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '*.control-cluster',
        value: '109.123.252.6',
      }),
    );
  });

  it('does nothing when it is already there and right', async () => {
    const { service, createRecord, updateRecord } = build([
      existing('109.123.252.6'),
    ]);

    await expect(
      service.ensureClusterWildcardRecord(assignment(), zone),
    ).resolves.toMatchObject({ status: 'published' });
    expect(createRecord).not.toHaveBeenCalled();
    expect(updateRecord).not.toHaveBeenCalled();
  });

  /**
   * A wildcard pointing somewhere else is somebody's decision. Taking it over
   * would silently redirect whatever it was serving — and the applications on
   * this cluster lose nothing, because the endpoint reconciliation goes on
   * writing their own records when the wildcard does not match.
   */
  it('leaves a wildcard that points somewhere else alone', async () => {
    const { service, createRecord, updateRecord } = build([
      existing('203.0.113.9'),
    ]);

    await expect(
      service.ensureClusterWildcardRecord(assignment(), zone),
    ).resolves.toMatchObject({
      status: 'foreign',
      actualValue: '203.0.113.9',
      expectedValue: '109.123.252.6',
    });
    expect(createRecord).not.toHaveBeenCalled();
    expect(updateRecord).not.toHaveBeenCalled();
  });

  it('does nothing for a cluster with no address yet', async () => {
    const { service, createRecord } = build([]);

    await expect(
      service.ensureClusterWildcardRecord(assignment({ ip: null }), zone),
    ).resolves.toMatchObject({ status: 'unavailable' });
    expect(createRecord).not.toHaveBeenCalled();
  });
});

describe('the record the sandbox subdomain needs on its zone', () => {
  it('covers every application every guest will ever deploy', () => {
    expect(sandboxWildcardRecord(assignment(), zone, 'demo')).toEqual({
      name: '*.demo',
      type: DnsRecordType.A,
      value: '109.123.252.6',
      ttl: 300,
    });
  });

  it('is named after the label, not after the cluster', () => {
    expect(sandboxWildcardRecord(assignment(), zone, 'try')?.name).toBe(
      '*.try',
    );
  });

  it('is nothing at all until the cluster has an address', () => {
    expect(
      sandboxWildcardRecord(assignment({ ip: null }), zone, 'demo'),
    ).toBeNull();
  });

  it('is nothing at all for a label that is not a hostname label', () => {
    expect(sandboxWildcardRecord(assignment(), zone, 'not a label')).toBeNull();
  });
});

describe('DnsZoneReconciliationService.ensureWildcardRecord', () => {
  const build = (records: DnsRecordInfo[]) => {
    const createRecord = jest.fn().mockResolvedValue({});
    const service = new DnsZoneReconciliationService(
      null as never,
      null as never,
      null as never,
      {
        getDnsProviderOrFail: () => ({
          listRecords: jest.fn().mockResolvedValue(records),
          createRecord,
        }),
      } as never,
      sandboxOff,
    );
    return { service, createRecord };
  };

  const wanted = {
    name: '*.demo',
    type: DnsRecordType.A,
    value: '109.123.252.6',
    ttl: 300,
  };

  it('publishes the record when the zone has none', async () => {
    const { service, createRecord } = build([]);

    await expect(service.ensureWildcardRecord(zone, wanted)).resolves.toBe(
      'published',
    );
    expect(createRecord).toHaveBeenCalledWith(
      expect.objectContaining({ name: '*.demo', value: '109.123.252.6' }),
    );
  });

  it('writes nothing when the record is already what it should be', async () => {
    const { service, createRecord } = build([
      {
        recordId: 'r-1',
        zoneId: 'pz-1',
        type: DnsRecordType.A,
        name: '*.demo',
        value: '109.123.252.6',
        ttl: 300,
      },
    ]);

    await expect(service.ensureWildcardRecord(zone, wanted)).resolves.toBe(
      'present',
    );
    expect(createRecord).not.toHaveBeenCalled();
  });

  /**
   * A wildcard already pointing somewhere else is somebody's decision. Taking
   * it over would silently redirect whatever it was serving.
   */
  it('leaves a record that points somewhere else alone', async () => {
    const { service, createRecord } = build([
      {
        recordId: 'r-1',
        zoneId: 'pz-1',
        type: DnsRecordType.A,
        name: '*.demo',
        value: '203.0.113.9',
        ttl: 300,
      },
    ]);

    await expect(service.ensureWildcardRecord(zone, wanted)).resolves.toBe(
      'foreign',
    );
    expect(createRecord).not.toHaveBeenCalled();
  });
});

describe('DnsZoneReconciliationService.buildExpectation', () => {
  const build = (assignments: unknown[], sandbox = sandboxOff) =>
    new DnsZoneReconciliationService(
      null as never,
      null as never,
      { find: jest.fn().mockResolvedValue(assignments) } as never,
      null as never,
      sandbox,
    );

  /**
   * The sweep deletes any A record pointing at a cluster master IP that no
   * endpoint claims. Without the wildcard in the expected set, that is exactly
   * what the wildcard is — so the reconciler would delete the record every
   * application on the cluster resolves through.
   */
  it('expects the wildcard, so the orphan sweep cannot delete it', async () => {
    const plan = await build([assignment()]).buildExpectation(zone);

    expect(plan.expected).toContainEqual({
      name: '*.control-cluster',
      type: DnsRecordType.A,
      value: '109.123.252.6',
      ttl: 300,
    });
  });

  /**
   * `*.demo` is an A record pointing at a cluster master IP that no endpoint
   * claims — the exact definition of the orphan the sweep deletes. Left out of
   * the expected set it would be removed on the next reconcile, and every guest
   * application on the installation would stop resolving until the next tenancy
   * was provisioned.
   */
  it('expects the sandbox subdomain wildcard too, on the cluster that has one', async () => {
    const plan = await build(
      [{ ...(assignment() as object), clusterId: 'c-sandbox' }],
      sandboxOn(),
    ).buildExpectation(zone);

    expect(plan.expected).toContainEqual({
      name: '*.demo',
      type: DnsRecordType.A,
      value: '109.123.252.6',
      ttl: 300,
    });
  });

  it('expects nothing of the sort when the installation configured none', async () => {
    const plan = await build([
      { ...(assignment() as object), clusterId: 'c-sandbox' },
    ]).buildExpectation(zone);

    expect(plan.expected.map((r) => r.name)).not.toContain('*.demo');
  });

  /**
   * The label describes one cluster's applications. Publishing it for a second
   * cluster sharing the zone would point a guest's visitors at a machine that
   * never heard of them.
   */
  it('does not expect it on a cluster the sandbox does not run on', async () => {
    const plan = await build(
      [{ ...(assignment({ name: 'workload' }) as object), clusterId: 'c-x' }],
      sandboxOn(),
    ).buildExpectation(zone);

    expect(plan.expected.map((r) => r.name)).not.toContain('*.demo');
  });

  it('expects one wildcard per cluster sharing the zone', async () => {
    const plan = await build([
      assignment({ name: 'control-cluster' }),
      assignment({ name: 'workload-cluster', ip: '203.0.113.4' }),
    ]).buildExpectation(zone);

    expect(plan.expected.filter((r) => r.name.startsWith('*.'))).toHaveLength(
      2,
    );
  });
});

/**
 * What the admin screen reads. It is a live provider call rather than a stored
 * flag on purpose: this is the screen somebody opens *to find out* whether the
 * record is there, and a record removed by hand must not keep showing as
 * published.
 */
describe('DnsZoneReconciliationService.inspectClusterWildcard', () => {
  const build = (listRecords: jest.Mock) => {
    const createRecord = jest.fn();
    const service = new DnsZoneReconciliationService(
      null as never,
      null as never,
      null as never,
      {
        getDnsProviderOrFail: () => ({ listRecords, createRecord }),
      } as never,
      sandboxOff,
    );
    return { service, createRecord };
  };

  it('reports the record and what it covers, in words', async () => {
    const { service, createRecord } = build(jest.fn().mockResolvedValue([]));

    const state = await service.inspectClusterWildcard(assignment(), zone);

    expect(state).toEqual({
      status: 'absent',
      fqdn: '*.control-cluster.dawit.blog',
      hostnamePattern: '<application>.control-cluster.dawit.blog',
      expectedValue: '109.123.252.6',
      actualValue: null,
    });
    // Looking must never publish.
    expect(createRecord).not.toHaveBeenCalled();
  });

  it('says unknown, not absent, when the provider cannot be read', async () => {
    const { service } = build(jest.fn().mockRejectedValue(new Error('429')));

    const state = await service.inspectClusterWildcard(assignment(), zone);

    // The difference matters: "absent" invites a button, "unknown" does not.
    expect(state.status).toBe('unknown');
    expect(state.fqdn).toBe('*.control-cluster.dawit.blog');
  });

  it('has nothing to report before the cluster has an address', async () => {
    const { service } = build(jest.fn().mockResolvedValue([]));

    expect(
      await service.inspectClusterWildcard(assignment({ ip: null }), zone),
    ).toMatchObject({ status: 'unavailable', fqdn: null });
  });
});
