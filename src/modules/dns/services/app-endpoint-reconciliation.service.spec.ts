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

  function build(dnsProvider: Record<string, jest.Mock>) {
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
});
