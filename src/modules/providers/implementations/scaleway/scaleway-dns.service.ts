import { Injectable, Logger, Inject } from '@nestjs/common';
import {
  Configuration,
  DNSZonesApi,
  RecordsApi,
  ScalewayDomainV2beta1DNSZone,
  ScalewayDomainV2beta1Record,
  ListDNSZoneRecordsTypeEnum,
} from './generated/domain';
import {
  IDnsProvider,
  DnsZoneInfo,
  DnsRecordInfo,
  DnsRecordType,
  CreateDnsRecordConfig,
  UpdateDnsRecordConfig,
  SetDnsRecordValuesConfig,
} from '../../interfaces/dns-provider.interface';
import { ICredentialProvider } from '../../interfaces/credential-provider.interface';
import { CloudProvider } from '../../enums/cloud-provider.enum';

@Injectable()
export class ScalewayDnsService implements IDnsProvider {
  private readonly logger = new Logger(ScalewayDnsService.name);

  constructor(
    @Inject('ICredentialProvider')
    private readonly credentialProvider: ICredentialProvider,
  ) {}

  // ─── API factory ────────────────────────────────────────────────────────────

  private async createZonesApi(): Promise<DNSZonesApi> {
    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );
    return new DNSZonesApi(
      new Configuration({
        baseOptions: { headers: { 'X-Auth-Token': token } },
      }),
    );
  }

  private async createRecordsApi(): Promise<RecordsApi> {
    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );
    return new RecordsApi(
      new Configuration({
        baseOptions: { headers: { 'X-Auth-Token': token } },
      }),
    );
  }

  // ─── Zone operations ────────────────────────────────────────────────────────

  async listZones(): Promise<DnsZoneInfo[]> {
    const api = await this.createZonesApi();
    const resp = await api.listDNSZones('', '');
    return (resp.data.dns_zones ?? []).map((z) => this.mapZone(z));
  }

  async getZone(zoneId: string): Promise<DnsZoneInfo | null> {
    const zones = await this.listZones();
    return zones.find((z) => z.zoneId === zoneId) ?? null;
  }

  async getZoneByName(name: string): Promise<DnsZoneInfo | null> {
    return this.getZone(name);
  }

  // ─── Record operations ──────────────────────────────────────────────────────

  async listRecords(zoneId: string): Promise<DnsRecordInfo[]> {
    const api = await this.createRecordsApi();
    const resp = await api.listDNSZoneRecords(zoneId, '');
    return (resp.data.records ?? []).map((r) => this.mapRecord(r, zoneId));
  }

  async getRecord(
    zoneId: string,
    recordId: string,
  ): Promise<DnsRecordInfo | null> {
    const api = await this.createRecordsApi();
    const resp = await api.listDNSZoneRecords(
      zoneId,
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      recordId,
    );
    const r = resp.data.records?.[0];
    return r ? this.mapRecord(r, zoneId) : null;
  }

  async createRecord(config: CreateDnsRecordConfig): Promise<DnsRecordInfo> {
    const api = await this.createRecordsApi();
    await api.updateDNSZoneRecords(config.zoneId, {
      changes: [
        {
          add: {
            records: [
              {
                name: config.name,
                type: config.type,
                data: config.value,
                ttl: config.ttl ?? 300,
              },
            ],
          },
        },
      ],
      return_all_records: false,
    });

    // Retrieve the newly created record by name+type
    const listResp = await api.listDNSZoneRecords(
      config.zoneId,
      config.name,
      undefined,
      undefined,
      undefined,
      undefined,
      config.type as unknown as ListDNSZoneRecordsTypeEnum,
    );
    const created = (listResp.data.records ?? []).find(
      (r) => r.data === config.value,
    );
    if (!created) {
      throw new Error(
        `Record created but could not be retrieved (zone=${config.zoneId} name=${config.name} type=${config.type})`,
      );
    }
    return this.mapRecord(created, config.zoneId);
  }

  async updateRecord(config: UpdateDnsRecordConfig): Promise<DnsRecordInfo> {
    const api = await this.createRecordsApi();
    // Scaleway has no direct update — use set by id
    await api.updateDNSZoneRecords(config.zoneId, {
      changes: [
        {
          set: {
            id: config.recordId,
            records: [
              {
                name: config.name,
                type: config.type,
                data: config.value,
                ttl: config.ttl ?? 300,
              },
            ],
          },
        },
      ],
      return_all_records: false,
    });

    const updated = await this.getRecord(config.zoneId, config.recordId);
    if (!updated) {
      throw new Error(
        `Record updated but could not be retrieved (zoneId=${config.zoneId} recordId=${config.recordId})`,
      );
    }
    return updated;
  }

  /** A `set` keyed on name and type replaces every value of that name at once. */
  async setRecordValues(
    config: SetDnsRecordValuesConfig,
  ): Promise<DnsRecordInfo[]> {
    const values = [...new Set(config.values)];
    if (values.length === 0) {
      throw new Error(
        `Refusing to leave ${config.name} (${config.type}) with no value`,
      );
    }
    const api = await this.createRecordsApi();
    await api.updateDNSZoneRecords(config.zoneId, {
      changes: [
        {
          set: {
            id_fields: {
              name: config.name,
              type: config.type,
            },
            records: values.map((value) => ({
              name: config.name,
              type: config.type,
              data: value,
              ttl: config.ttl,
            })),
          },
        },
      ],
      return_all_records: false,
    });
    const listResp = await api.listDNSZoneRecords(
      config.zoneId,
      config.name,
      undefined,
      undefined,
      undefined,
      undefined,
      config.type as unknown as ListDNSZoneRecordsTypeEnum,
    );
    return (listResp.data.records ?? [])
      .filter((r) => r.data !== undefined && values.includes(r.data))
      .map((r) => this.mapRecord(r, config.zoneId));
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    const api = await this.createRecordsApi();
    await api.updateDNSZoneRecords(zoneId, {
      changes: [
        {
          delete: { id: recordId },
        },
      ],
    });
  }

  async bulkCreateRecords(
    zoneId: string,
    records: CreateDnsRecordConfig[],
  ): Promise<DnsRecordInfo[]> {
    const api = await this.createRecordsApi();
    await api.updateDNSZoneRecords(zoneId, {
      changes: records.map((r) => ({
        add: {
          records: [
            {
              name: r.name,
              type: r.type,
              data: r.value,
              ttl: r.ttl ?? 300,
            },
          ],
        },
      })),
      return_all_records: false,
    });

    // Return all records for the zone after bulk insert
    const allRecords = await this.listRecords(zoneId);
    return allRecords.filter((existing) =>
      records.some(
        (r) =>
          existing.name === r.name &&
          existing.type === r.type &&
          existing.value === r.value,
      ),
    );
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.listZones();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ─── Mapping helpers ─────────────────────────────────────────────────────────

  private mapZone(z: ScalewayDomainV2beta1DNSZone): DnsZoneInfo {
    // Scaleway zone name = subdomain + domain (e.g. 'example.com' or 'sub.example.com')
    const name = z.subdomain ? `${z.subdomain}.${z.domain}` : (z.domain ?? '');
    return {
      zoneId: name,
      name,
      ttl: 300,
      recordCount: 0,
      status: z.status ?? 'active',
    };
  }

  private mapRecord(
    r: ScalewayDomainV2beta1Record,
    zoneId: string,
  ): DnsRecordInfo {
    // Scaleway records have no label support — deleteRecordsByClusterId is a no-op for Scaleway zones
    return {
      recordId: r.id ?? '',
      zoneId,
      type: (r.type as DnsRecordType) ?? DnsRecordType.A,
      name: r.name ?? '',
      value: r.data ?? '',
      ttl: r.ttl ?? 300,
    };
  }
}
