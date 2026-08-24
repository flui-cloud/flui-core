// Pulled in transitively and ship ESM that jest won't parse; unused on this path.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { AppEndpointReconciliationService } from './app-endpoint-reconciliation.service';
import {
  DnsRecordInfo,
  DnsRecordType,
} from '../../providers/interfaces/dns-provider.interface';

/**
 * Regression cover for the stale-A-record incident: a rebuilt control cluster
 * left the decommissioned one's IP answering alongside the live one, so DNS
 * round-robin blackholed roughly half of every request to auth/api/dashboard.
 */
describe('AppEndpointReconciliationService.writePrimaryRecord', () => {
  const ZONE_ID = 'zone-1';
  const LIVE_IP = '62.238.51.202';
  const DEAD_IP = '142.132.180.30';

  const staleRecord: DnsRecordInfo = {
    recordId: `auth/A:${DEAD_IP}`,
    zoneId: ZONE_ID,
    type: DnsRecordType.A,
    name: 'auth',
    value: DEAD_IP,
    ttl: 300,
  };

  function build(dnsProvider: Record<string, jest.Mock>, sandbox = false) {
    const factory = {
      getDnsProviderOrFail: jest.fn().mockReturnValue(dnsProvider),
    };
    // Only the provider factory is exercised by this path.
    const service = new AppEndpointReconciliationService(
      null as never,
      null as never,
      null as never,
      factory as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      { exists: jest.fn().mockResolvedValue(sandbox) } as never,
    );
    return service;
  }

  const write = (
    service: AppEndpointReconciliationService,
    dnsRecordId: string | null,
  ) =>
    (
      service as unknown as {
        writePrimaryRecord: (...a: unknown[]) => Promise<DnsRecordInfo>;
      }
    ).writePrimaryRecord(
      { id: 'ep-1', fqdn: 'auth.flui.cloud', dnsRecordId, dnsRecordType: 'A' },
      {
        providerZoneId: ZONE_ID,
        zoneName: 'flui.cloud',
        dnsProvider: 'hetzner',
      },
      { id: 'cluster-new' },
      'auth',
      LIVE_IP,
      300,
    );

  const defaults = () => ({
    getRecord: jest.fn().mockResolvedValue(null),
    listRecords: jest.fn().mockResolvedValue([]),
    createRecord: jest
      .fn()
      .mockImplementation(async (c: { value: string }) => ({
        ...c,
        value: c.value,
      })),
    updateRecord: jest
      .fn()
      .mockImplementation(async (c: { value: string }) => ({
        ...c,
        value: c.value,
      })),
  });

  // The bug: dropping the cluster cascaded dnsRecordId away, so this path ran
  // blind and the Hetzner adapter appended to the RRSet instead of replacing.
  it('adopts an existing record for the same name+type instead of creating a second value', async () => {
    const provider = {
      ...defaults(),
      listRecords: jest.fn().mockResolvedValue([staleRecord]),
    };
    const service = build(provider);

    await write(service, null);

    expect(provider.createRecord).not.toHaveBeenCalled();
    expect(provider.updateRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: staleRecord.recordId,
        value: LIVE_IP,
      }),
    );
  });

  it('re-labels the adopted record to the cluster that now owns it', async () => {
    const provider = {
      ...defaults(),
      listRecords: jest.fn().mockResolvedValue([staleRecord]),
    };
    const service = build(provider);

    await write(service, null);

    expect(provider.updateRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: expect.objectContaining({ 'flui-cluster-id': 'cluster-new' }),
      }),
    );
  });

  it('creates when nothing answers for that name yet', async () => {
    const provider = defaults();
    const service = build(provider);

    await write(service, null);

    expect(provider.updateRecord).not.toHaveBeenCalled();
    expect(provider.createRecord).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'auth', value: LIVE_IP }),
    );
  });

  it('prefers the known record id over a name lookup', async () => {
    const provider = {
      ...defaults(),
      getRecord: jest.fn().mockResolvedValue(staleRecord),
      listRecords: jest.fn(),
    };
    const service = build(provider);

    await write(service, staleRecord.recordId);

    expect(provider.listRecords).not.toHaveBeenCalled();
    expect(provider.updateRecord).toHaveBeenCalled();
  });

  it('writes nothing when the record already points at the right IP', async () => {
    const provider = {
      ...defaults(),
      listRecords: jest
        .fn()
        .mockResolvedValue([{ ...staleRecord, value: LIVE_IP }]),
    };
    const service = build(provider);

    await write(service, null);

    expect(provider.createRecord).not.toHaveBeenCalled();
    expect(provider.updateRecord).not.toHaveBeenCalled();
  });

  it('falls back to creating when the zone cannot be listed', async () => {
    const provider = {
      ...defaults(),
      listRecords: jest.fn().mockRejectedValue(new Error('403')),
    };
    const service = build(provider);

    await write(service, null);

    expect(provider.createRecord).toHaveBeenCalled();
  });

  it('adopts one value when the name is already split-brained', async () => {
    const provider = {
      ...defaults(),
      listRecords: jest
        .fn()
        .mockResolvedValue([
          staleRecord,
          { ...staleRecord, recordId: `auth/A:${LIVE_IP}`, value: LIVE_IP },
        ]),
    };
    const service = build(provider);

    await write(service, null);

    expect(provider.createRecord).not.toHaveBeenCalled();
    expect(provider.updateRecord).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: staleRecord.recordId }),
    );
  });

  it('references noindex only for endpoints in a sandbox tenancy', async () => {
    const endpoint = {
      clusterId: 'cluster-1',
      k8sNamespace: 'user-guest-abc123',
    };
    const resolve = (service: AppEndpointReconciliationService) =>
      (
        service as unknown as {
          sandboxNoindexMiddlewareRef: (
            value: typeof endpoint,
          ) => Promise<string | null>;
        }
      ).sandboxNoindexMiddlewareRef(endpoint);

    await expect(resolve(build(defaults(), true))).resolves.toBe(
      'user-guest-abc123-sandbox-noindex@kubernetescrd',
    );
    await expect(resolve(build(defaults(), false))).resolves.toBeNull();
  });
});

describe('AppEndpointReconciliationService.deleteEndpointResources', () => {
  function build(
    deleteRecord: jest.Mock,
    serviceLabels?: Record<string, string>,
  ) {
    const endpoint = {
      id: 'endpoint-1',
      clusterId: 'cluster-1',
      fqdn: 'guest.example.test',
      k8sNamespace: 'user-guest-abc123',
      k8sServiceName: 'guest-svc',
      endpointType: 'public',
      certificateRequired: false,
      gatewayConfig: null,
      dnsRecordId: 'guest/A:192.0.2.10',
      dnsRecordType: 'A',
      clusterDnsZone: {
        dnsZone: {
          dnsProvider: 'hetzner',
          providerZoneId: 'zone-1',
          zoneName: 'example.test',
        },
      },
    };
    const appEndpoints = {
      getEndpoint: jest.fn().mockResolvedValue(endpoint),
      clearDnsRecord: jest.fn().mockResolvedValue(undefined),
    };
    const k8s = {
      deleteResource: jest.fn().mockResolvedValue(undefined),
      getResource: jest
        .fn()
        .mockResolvedValue(
          serviceLabels ? { metadata: { labels: serviceLabels } } : null,
        ),
      patchKubeconfigServer: jest.fn().mockReturnValue('kubeconfig'),
    };
    const service = new AppEndpointReconciliationService(
      {
        findOne: jest
          .fn()
          .mockResolvedValue({ id: 'cluster-1', kubeconfigEncrypted: 'enc' }),
      } as never,
      k8s as never,
      { decrypt: jest.fn().mockReturnValue('kubeconfig') } as never,
      {
        getDnsProviderOrFail: jest.fn().mockReturnValue({ deleteRecord }),
      } as never,
      null as never,
      appEndpoints as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      {
        fanOutDeleteToReplicas: jest.fn().mockResolvedValue(undefined),
      } as never,
      { allMiddlewareNames: jest.fn().mockReturnValue([]) } as never,
      null as never,
    );
    return { service, appEndpoints, k8s };
  }

  const deletedServices = (k8s: { deleteResource: jest.Mock }) =>
    k8s.deleteResource.mock.calls.filter((c) => c[1] === 'Service');

  it('clears the persisted DNS handle only after provider deletion succeeds', async () => {
    const deleteRecord = jest.fn().mockResolvedValue(undefined);
    const { service, appEndpoints } = build(deleteRecord);

    await expect(
      service.deleteEndpointResources('endpoint-1'),
    ).resolves.toBeUndefined();
    expect(deleteRecord).toHaveBeenCalledWith('zone-1', 'guest/A:192.0.2.10');
    expect(appEndpoints.clearDnsRecord).toHaveBeenCalledWith('endpoint-1');
  });

  it('fails teardown and preserves the DNS handle when the provider refuses', async () => {
    const deleteRecord = jest
      .fn()
      .mockRejectedValue(new Error('provider down'));
    const { service, appEndpoints } = build(deleteRecord);

    await expect(service.deleteEndpointResources('endpoint-1')).rejects.toThrow(
      'provider down',
    );
    expect(appEndpoints.clearDnsRecord).not.toHaveBeenCalled();
  });

  /**
   * The application's Service and the endpoint's Service can be the same name —
   * that is the whole of the bug. Removing one gateway route used to delete it,
   * and the application went off the air with its Ingress still standing.
   */
  it('keeps a Service this endpoint did not create', async () => {
    const { service, k8s } = build(jest.fn().mockResolvedValue(undefined), {
      'managed-by': 'flui-cloud',
      'app.kubernetes.io/managed-by': 'flui-cloud',
      'flui-app-id': 'app-1',
    });

    await service.deleteEndpointResources('endpoint-1');

    expect(deletedServices(k8s)).toHaveLength(0);
  });

  it('keeps a Service another endpoint created', async () => {
    const { service, k8s } = build(jest.fn().mockResolvedValue(undefined), {
      'managed-by': 'flui-cloud',
      'flui-endpoint-id': 'endpoint-2',
    });

    await service.deleteEndpointResources('endpoint-1');

    expect(deletedServices(k8s)).toHaveLength(0);
  });

  it('deletes the Service it created itself', async () => {
    const { service, k8s } = build(jest.fn().mockResolvedValue(undefined), {
      'managed-by': 'flui-cloud',
      'flui-endpoint-id': 'endpoint-1',
    });

    await service.deleteEndpointResources('endpoint-1');

    expect(deletedServices(k8s)).toEqual([
      ['kubeconfig', 'Service', 'guest-svc', 'user-guest-abc123'],
    ]);
  });
});

/**
 * A per-app A record for a name a zone wildcard already answers for is the same
 * answer, published the slow way: a brand-new name takes about a minute to
 * become resolvable, and that minute lands on the screen with the link to the
 * application on it.
 */
describe('AppEndpointReconciliationService.reconcileDnsRecord', () => {
  const ZONE_ID = 'zone-1';
  const IP = '109.123.252.6';

  const wildcard = (value = IP): DnsRecordInfo => ({
    recordId: 'wildcard-record',
    zoneId: ZONE_ID,
    type: DnsRecordType.A,
    name: '*.control-cluster',
    value,
    ttl: 300,
  });

  function build(records: DnsRecordInfo[]) {
    const createRecord = jest
      .fn()
      .mockImplementation(async (c: Record<string, unknown>) => ({
        ...c,
        recordId: 'new-record',
      }));
    const dnsProvider = {
      getRecord: jest.fn().mockResolvedValue(null),
      listRecords: jest.fn().mockResolvedValue(records),
      createRecord,
      updateRecord: jest.fn(),
    };
    const service = new AppEndpointReconciliationService(
      null as never,
      null as never,
      null as never,
      { getDnsProviderOrFail: () => dnsProvider } as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      { fanOutRecordToReplicas: jest.fn() } as never,
      null as never,
      { exists: jest.fn().mockResolvedValue(false) } as never,
    );
    return { service, createRecord };
  }

  const reconcile = (
    service: AppEndpointReconciliationService,
    fqdn = 'demo-app.control-cluster.dawit.blog',
  ) =>
    (
      service as unknown as {
        reconcileDnsRecord: (...a: unknown[]) => Promise<DnsRecordInfo>;
      }
    ).reconcileDnsRecord(
      { id: 'ep-1', fqdn, dnsRecordId: null, dnsRecordType: 'A' },
      {
        dnsZone: {
          providerZoneId: ZONE_ID,
          zoneName: 'dawit.blog',
          dnsProvider: 'hetzner',
          recordTtlSeconds: 300,
        },
      },
      { id: 'cluster-1', masterIpAddress: IP },
    );

  it('writes no per-app record when the zone wildcard already answers', async () => {
    const { service, createRecord } = build([wildcard()]);

    const result = await reconcile(service);

    expect(createRecord).not.toHaveBeenCalled();
    expect(result.value).toBe(IP);
  });

  /**
   * Teardown deletes what an endpoint owns. Handing back the wildcard's id
   * would have the first tenancy to expire delete the record every other
   * tenancy is resolving through.
   */
  it('does not claim the wildcard as the endpoint’s own record', async () => {
    const { service } = build([wildcard()]);

    const result = await reconcile(service);

    expect(result.recordId).toBe('');
  });

  it('still writes a record when the wildcard points somewhere else', async () => {
    const { service, createRecord } = build([wildcard('203.0.113.9')]);

    await reconcile(service);

    expect(createRecord).toHaveBeenCalled();
  });

  // `*.control-cluster` answers for `app.control-cluster`, never for
  /**
   * The measurement the sandbox subdomain rests on, and the reason it needed no
   * new code here: applications under `demo` sit one label under it, exactly as
   * applications sit one label under the cluster name, so `*.demo` is found by
   * the same search. Hundreds of guests, not one per-application record.
   */
  it('finds the sandbox subdomain wildcard for a name under it', async () => {
    const { service, createRecord } = build([
      { ...wildcard(), name: '*.demo' },
    ]);

    const result = await reconcile(service, 'it-tools.demo.dawit.blog');

    expect(createRecord).not.toHaveBeenCalled();
    expect(result.name).toBe('*.demo');
  });

  // `a.b.control-cluster` — one label, which is all a DNS wildcard matches.
  it('does not treat a wildcard as covering a name two labels deep', async () => {
    const { service, createRecord } = build([wildcard()]);

    await reconcile(service, 'app.team.control-cluster.dawit.blog');

    expect(createRecord).toHaveBeenCalled();
  });

  // A wildcard answers for names *under* the zone, never for the zone itself.
  it('does not treat a root wildcard as covering the zone apex', async () => {
    const { service, createRecord } = build([{ ...wildcard(), name: '*' }]);

    await reconcile(service, 'dawit.blog');

    expect(createRecord).toHaveBeenCalled();
  });

  it('writes a record when the zone has no wildcard at all', async () => {
    const { service, createRecord } = build([]);

    await reconcile(service);

    expect(createRecord).toHaveBeenCalled();
  });
});
