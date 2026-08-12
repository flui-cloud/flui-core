import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as https from 'node:https';
import {
  Configuration,
  ZonesApi,
  ZoneRRSetsApi,
  Record as HetznerRecord,
  RRSet,
  Zone,
  CreateZoneRequestRrsetsInner,
  CreateZoneRequestRrsetsInnerTypeEnum,
  DeleteZoneRrsetRrTypeEnum,
  GetZoneRrsetRrTypeEnum,
  UpdateZoneRrsetRrTypeEnum,
} from 'src/modules/providers/implementations/hetzner/generated';
import {
  IDnsProvider,
  DnsZoneInfo,
  DnsRecordInfo,
  DnsRecordType,
  CreateDnsRecordConfig,
  UpdateDnsRecordConfig,
} from '../interfaces/dns-provider.interface';
import { ICredentialProvider } from '../interfaces/credential-provider.interface';
import { CloudProvider } from '../enums/cloud-provider.enum';

/**
 * Hetzner DNS Service - Cloud API implementation
 *
 * Uses the Hetzner Cloud API (api.hetzner.cloud/v1) with the same Bearer token
 * as other Hetzner Cloud services. The Cloud API uses RRSets (grouped by name+type)
 * instead of individual records. This service maps between the IDnsProvider
 * individual record interface and the RRSet model.
 *
 * Record IDs are composed as "{name}/{type}:{value}" to uniquely identify
 * individual values within an RRSet.
 */
@Injectable()
export class HetznerDnsService implements IDnsProvider {
  private readonly logger = new Logger(HetznerDnsService.name);
  private readonly basePath: string;
  private readonly timeout: number;

  constructor(
    private readonly configService: ConfigService,
    @Inject('ICredentialProvider')
    private readonly credentialProvider: ICredentialProvider,
  ) {
    this.basePath = this.configService.get<string>(
      'HETZNER_API_BASE_PATH',
      'https://api.hetzner.cloud/v1',
    );
    this.timeout = Number.parseInt(
      this.configService.get<string>('HETZNER_TIMEOUT', '10000'),
      10,
    );
  }

  private createAxiosInstance(): AxiosInstance {
    const httpsAgent = new https.Agent({
      keepAlive: false,
      rejectUnauthorized: true,
      family: 4,
    });

    const instance = axios.create({
      timeout: this.timeout,
      httpsAgent,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Flui-Cloud-API/1.0',
      },
      validateStatus: (status) => status >= 200 && status < 300,
    });

    instance.interceptors.request.use(
      (config) => {
        this.logger.debug(
          `Hetzner DNS API Request: ${config.method?.toUpperCase()} ${config.url}`,
        );
        return config;
      },
      (error) => {
        this.logger.error(`Hetzner DNS API Request Error: ${error.message}`);
        return Promise.reject(error);
      },
    );

    instance.interceptors.response.use(
      (response) => {
        this.logger.debug(
          `Hetzner DNS API Response: ${response.status} ${response.statusText}`,
        );
        return response;
      },
      (error) => {
        if (error.response) {
          this.logger.error(
            `Hetzner DNS API Error: ${error.response.status} ${error.response.statusText}`,
          );
          this.logger.error(
            `Error Data: ${JSON.stringify(error.response.data, null, 2)}`,
          );
        } else if (error.request) {
          this.logger.error(
            `Hetzner DNS API No Response Received - code: ${error.code}, message: ${error.message}`,
          );
        } else {
          this.logger.error(`Hetzner DNS API Error: ${error.message}`);
        }
        return Promise.reject(error);
      },
    );

    return instance;
  }

  private async createConfiguration(): Promise<Configuration> {
    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.HETZNER,
    );

    return new Configuration({
      accessToken: token,
      basePath: this.basePath,
      baseOptions: {
        headers: {
          'User-Agent': 'Flui-Cloud-API/1.0',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      },
    });
  }

  private async createZonesApi(): Promise<ZonesApi> {
    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.HETZNER,
    );
    const configuration = await this.createConfiguration();
    const axiosInstance = this.createAxiosInstance();
    axiosInstance.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    return new ZonesApi(configuration, this.basePath, axiosInstance);
  }

  private async createRRSetsApi(): Promise<ZoneRRSetsApi> {
    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.HETZNER,
    );
    const configuration = await this.createConfiguration();
    const axiosInstance = this.createAxiosInstance();
    axiosInstance.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    return new ZoneRRSetsApi(configuration, this.basePath, axiosInstance);
  }

  // ── Zone operations ──────────────────────────────────────────────

  async listZones(): Promise<DnsZoneInfo[]> {
    const zonesApi = await this.createZonesApi();
    const response = await zonesApi.listZones();
    return response.data.zones.map((zone) => this.mapZone(zone));
  }

  async getZone(zoneId: string): Promise<DnsZoneInfo | null> {
    try {
      const zonesApi = await this.createZonesApi();
      const response = await zonesApi.getZone(zoneId);
      return this.mapZone(response.data.zone);
    } catch (error) {
      if (error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async getZoneByName(name: string): Promise<DnsZoneInfo | null> {
    const zonesApi = await this.createZonesApi();
    const response = await zonesApi.listZones(name);
    const zone = response.data.zones.find((z) => z.name === name);
    return zone ? this.mapZone(zone) : null;
  }

  // ── Record operations (mapped to RRSets) ────────────────────────

  async listRecords(zoneId: string): Promise<DnsRecordInfo[]> {
    const rrSetsApi = await this.createRRSetsApi();

    const allRecords: DnsRecordInfo[] = [];
    let page = 1;
    const perPage = 100;

    // Paginate through all RRSets
    while (true) {
      const response = await rrSetsApi.listZoneRrsets(
        zoneId,
        undefined, // name filter
        undefined, // type filter
        undefined, // label selector
        undefined, // sort
        page,
        perPage,
      );

      for (const rrset of response.data.rrsets) {
        const mappedRecords = this.flattenRRSet(rrset, zoneId);
        allRecords.push(...mappedRecords);
      }

      // Check if we got fewer results than page size (last page)
      if (response.data.rrsets.length < perPage) {
        break;
      }
      page++;
    }

    return allRecords;
  }

  async getRecord(
    zoneId: string,
    recordId: string,
  ): Promise<DnsRecordInfo | null> {
    const parsed = this.parseRecordId(recordId);
    if (!parsed) {
      return null;
    }

    try {
      const rrSetsApi = await this.createRRSetsApi();
      const response = await rrSetsApi.getZoneRrset(
        zoneId,
        parsed.name,
        parsed.type as GetZoneRrsetRrTypeEnum,
      );

      const rrset = response.data.rrset;
      const matchingRecord = rrset.records.find(
        (r) => r.value === parsed.value,
      );

      if (!matchingRecord) {
        return null;
      }

      return {
        recordId,
        zoneId: zoneId,
        type: rrset.type as DnsRecordType,
        name: rrset.name,
        value: matchingRecord.value,
        ttl: rrset.ttl ?? 0,
      };
    } catch (error) {
      if (error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async createRecord(config: CreateDnsRecordConfig): Promise<DnsRecordInfo> {
    const rrSetsApi = await this.createRRSetsApi();
    const ttl = config.ttl ?? 300;

    // Check if an RRSet already exists for this name+type
    let existingRRSet: RRSet | null = null;
    try {
      const response = await rrSetsApi.getZoneRrset(
        config.zoneId,
        config.name,
        config.type as GetZoneRrsetRrTypeEnum,
      );
      existingRRSet = response.data.rrset;
    } catch (error) {
      if (error.response?.status !== 404) {
        throw error;
      }
    }

    if (existingRRSet) {
      // RRSet exists — add the new value by replacing all records with existing + new
      const existingValues = existingRRSet.records.map((r) => r.value);
      if (existingValues.includes(config.value)) {
        // Value already exists, return it as-is
        this.logger.debug(
          `DNS record already exists: ${config.type} ${config.name} -> ${config.value}`,
        );
        return {
          recordId: this.composeRecordId(
            config.name,
            config.type,
            config.value,
          ),
          zoneId: config.zoneId,
          type: config.type,
          name: config.name,
          value: config.value,
          ttl: existingRRSet.ttl ?? ttl,
        };
      }

      // Add the new record value to the existing RRSet using set-records
      const newRecords: HetznerRecord[] = [
        ...existingRRSet.records,
        { value: txtSafe(config.type, config.value) },
      ];

      await this.setRRSetRecords(
        rrSetsApi,
        config.zoneId,
        config.name,
        config.type,
        newRecords,
        existingRRSet.ttl ?? ttl,
      );
    } else {
      // Create new RRSet
      const createRequest: CreateZoneRequestRrsetsInner = {
        name: config.name,
        type: config.type as CreateZoneRequestRrsetsInnerTypeEnum,
        ttl,
        records: [{ value: txtSafe(config.type, config.value) }],
      };

      await rrSetsApi.createZoneRrset(config.zoneId, createRequest);
    }

    if (config.labels && Object.keys(config.labels).length > 0) {
      await this.applyLabels(
        rrSetsApi,
        config.zoneId,
        config.name,
        config.type,
        config.labels,
      );
    }

    this.logger.log(
      `Created DNS record: ${config.type} ${config.name} -> ${config.value}`,
    );

    return {
      recordId: this.composeRecordId(config.name, config.type, config.value),
      zoneId: config.zoneId,
      type: config.type,
      name: config.name,
      value: config.value,
      ttl,
      labels: config.labels,
    };
  }

  async updateRecord(config: UpdateDnsRecordConfig): Promise<DnsRecordInfo> {
    const parsed = this.parseRecordId(config.recordId);
    if (!parsed) {
      throw new Error(`Invalid record ID format: ${config.recordId}`);
    }

    const rrSetsApi = await this.createRRSetsApi();
    const ttl = config.ttl ?? 300;

    // If name+type changed, we need to delete from old RRSet and create in new one
    if (parsed.name !== config.name || parsed.type !== config.type) {
      await this.removeValueFromRRSet(
        rrSetsApi,
        config.zoneId,
        parsed.name,
        parsed.type,
        parsed.value,
      );

      return this.createRecord({
        zoneId: config.zoneId,
        type: config.type,
        name: config.name,
        value: config.value,
        ttl,
        labels: config.labels,
      });
    }

    // Same name+type — replace old value with new value in the RRSet
    try {
      const response = await rrSetsApi.getZoneRrset(
        config.zoneId,
        config.name,
        config.type as GetZoneRrsetRrTypeEnum,
      );
      const rrset = response.data.rrset;

      const newRecords: HetznerRecord[] = rrset.records
        .filter((r) => r.value !== parsed.value)
        .concat([{ value: txtSafe(config.type, config.value) }]);

      await this.setRRSetRecords(
        rrSetsApi,
        config.zoneId,
        config.name,
        config.type,
        newRecords,
        // An explicit request wins; otherwise the record keeps the timing it
        // had, because editing a value is not a request to retime it.
        config.ttl ?? rrset.ttl ?? ttl,
      );

      // setRRSetRecords is delete+recreate, so labels don't survive it. Without
      // re-applying, label-predicated cleanup can never reclaim the record.
      if (config.labels) {
        await this.applyLabels(
          rrSetsApi,
          config.zoneId,
          config.name,
          config.type,
          config.labels,
        );
      }
    } catch (error) {
      if (error.response?.status === 404) {
        // RRSet doesn't exist, create it
        return this.createRecord({
          zoneId: config.zoneId,
          type: config.type,
          name: config.name,
          value: config.value,
          ttl,
          labels: config.labels,
        });
      }
      throw error;
    }

    this.logger.log(
      `Updated DNS record ${config.recordId}: ${config.type} ${config.name} -> ${config.value}`,
    );

    return {
      recordId: this.composeRecordId(config.name, config.type, config.value),
      zoneId: config.zoneId,
      type: config.type,
      name: config.name,
      value: config.value,
      ttl,
    };
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    const parsed = this.parseRecordId(recordId);
    if (!parsed) {
      throw new Error(`Invalid record ID format: ${recordId}`);
    }

    const rrSetsApi = await this.createRRSetsApi();
    await this.removeValueFromRRSet(
      rrSetsApi,
      zoneId,
      parsed.name,
      parsed.type,
      parsed.value,
    );

    this.logger.log(`Deleted DNS record ${recordId} from zone ${zoneId}`);
  }

  async bulkCreateRecords(
    zoneId: string,
    records: CreateDnsRecordConfig[],
  ): Promise<DnsRecordInfo[]> {
    // Group records by name+type to batch into RRSet operations
    const grouped = new Map<string, CreateDnsRecordConfig[]>();
    for (const record of records) {
      const key = `${record.name}/${record.type}`;
      const existing = grouped.get(key) || [];
      existing.push(record);
      grouped.set(key, existing);
    }

    const rrSetsApi = await this.createRRSetsApi();
    const results: DnsRecordInfo[] = [];

    for (const [, groupRecords] of grouped) {
      const first = groupRecords[0];
      const ttl = first.ttl ?? 300;

      // Check if RRSet already exists
      let existingRRSet: RRSet | null = null;
      try {
        const response = await rrSetsApi.getZoneRrset(
          zoneId,
          first.name,
          first.type as GetZoneRrsetRrTypeEnum,
        );
        existingRRSet = response.data.rrset;
      } catch (error) {
        if (error.response?.status !== 404) {
          throw error;
        }
      }

      const newValues = groupRecords.map((r) => r.value);

      if (existingRRSet) {
        // Merge with existing records, avoiding duplicates
        const existingValues = new Set(
          existingRRSet.records.map((r) => r.value),
        );
        const allRecords: HetznerRecord[] = [...existingRRSet.records];

        for (const value of newValues) {
          if (!existingValues.has(value)) {
            allRecords.push({ value });
          }
        }

        await this.setRRSetRecords(
          rrSetsApi,
          zoneId,
          first.name,
          first.type,
          allRecords,
          existingRRSet.ttl ?? ttl,
        );
      } else {
        // Create new RRSet with all values
        const createRequest: CreateZoneRequestRrsetsInner = {
          name: first.name,
          type: first.type as CreateZoneRequestRrsetsInnerTypeEnum,
          ttl,
          records: newValues.map((v) => ({ value: v })),
        };

        await rrSetsApi.createZoneRrset(zoneId, createRequest);
      }

      for (const record of groupRecords) {
        results.push({
          recordId: this.composeRecordId(
            record.name,
            record.type,
            record.value,
          ),
          zoneId,
          type: record.type,
          name: record.name,
          value: record.value,
          ttl,
        });
      }
    }

    this.logger.log(
      `Bulk created ${results.length} DNS records in zone ${zoneId}`,
    );
    return results;
  }

  async purgeARecords(zoneId: string): Promise<number> {
    const rrSetsApi = await this.createRRSetsApi();
    const records = await this.listRecords(zoneId);
    const aNames = [
      ...new Set(
        records.filter((r) => r.type === DnsRecordType.A).map((r) => r.name),
      ),
    ];

    let deleted = 0;
    for (const name of aNames) {
      try {
        await rrSetsApi.deleteZoneRrset(
          zoneId,
          name,
          DeleteZoneRrsetRrTypeEnum.A,
        );
        deleted++;
      } catch (error) {
        if (error.response?.status === 404) continue;
        throw error;
      }
    }
    return deleted;
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.listZones();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ── RRSet helpers ────────────────────────────────────────────────

  /**
   * Replace all records in an RRSet using the set-records endpoint.
   * The Cloud API uses POST /zones/{id}/rrsets/{name}/{type}/records
   * with body { records: [...] } to replace all record values.
   *
   * Since the generated client's updateZoneRrset only supports label changes,
   * we use a direct axios call for the set-records operation.
   */
  private async setRRSetRecords(
    rrSetsApi: ZoneRRSetsApi,
    zoneId: string,
    name: string,
    type: string,
    records: HetznerRecord[],
    /**
     * Carried explicitly because this is a delete-and-recreate: an RRSet
     * recreated without one is given the zone default, so every edit silently
     * retimed the record it was editing. A record written at 300s and then
     * corrected came back at 3600s, which turns a one-line mistake into an hour
     * of stale answers — the same trap the labels above document.
     */
    ttl: number,
  ): Promise<void> {
    // The generated client doesn't expose set-records directly,
    // so we delete the RRSet and recreate it with the new values
    try {
      await rrSetsApi.deleteZoneRrset(
        zoneId,
        name,
        type as DeleteZoneRrsetRrTypeEnum,
      );
    } catch (error) {
      // If the RRSet doesn't exist, that's fine
      if (error.response?.status !== 404) {
        throw error;
      }
    }

    // Only recreate if there are records to add
    if (records.length > 0) {
      const createRequest: CreateZoneRequestRrsetsInner = {
        name,
        type: type as CreateZoneRequestRrsetsInnerTypeEnum,
        ttl,
        records: records.map((r) => ({ value: r.value })),
      };

      await rrSetsApi.createZoneRrset(zoneId, createRequest);
    }
  }

  private async applyLabels(
    rrSetsApi: ZoneRRSetsApi,
    zoneId: string,
    name: string,
    type: string,
    labels: Record<string, string>,
  ): Promise<void> {
    try {
      await rrSetsApi.updateZoneRrset(
        zoneId,
        name,
        type as UpdateZoneRrsetRrTypeEnum,
        { labels },
      );
    } catch (error) {
      this.logger.warn(
        `Failed to apply labels to RRSet ${name}/${type}: ${error.message}`,
      );
    }
  }

  /**
   * Remove a single value from an RRSet.
   * If it's the last value, deletes the entire RRSet.
   */
  private async removeValueFromRRSet(
    rrSetsApi: ZoneRRSetsApi,
    zoneId: string,
    name: string,
    type: string,
    value: string,
  ): Promise<void> {
    try {
      const response = await rrSetsApi.getZoneRrset(
        zoneId,
        name,
        type as GetZoneRrsetRrTypeEnum,
      );
      const rrset = response.data.rrset;
      const remaining = rrset.records.filter((r) => r.value !== value);

      if (remaining.length === 0) {
        // Delete the entire RRSet
        await rrSetsApi.deleteZoneRrset(
          zoneId,
          name,
          type as DeleteZoneRrsetRrTypeEnum,
        );
      } else {
        // Replace with remaining records
        // Removing one value from an RRSet must not retime the ones that stay.
        await this.setRRSetRecords(
          rrSetsApi,
          zoneId,
          name,
          type,
          remaining,
          rrset.ttl ?? 300,
        );
      }
    } catch (error) {
      if (error.response?.status === 404) {
        // Already gone — nothing to do
        return;
      }
      throw error;
    }
  }

  // ── Mapping helpers ──────────────────────────────────────────────

  /**
   * Compose a synthetic record ID from name, type, and value.
   * Format: "{name}/{type}:{value}"
   */
  private composeRecordId(name: string, type: string, value: string): string {
    return `${name}/${type}:${value}`;
  }

  /**
   * Parse a synthetic record ID back into its components.
   * Expected format: "{name}/{type}:{value}"
   */
  private parseRecordId(
    recordId: string,
  ): { name: string; type: string; value: string } | null {
    // Format: name/TYPE:value
    const slashIndex = recordId.indexOf('/');
    if (slashIndex === -1) {
      return null;
    }

    const name = recordId.substring(0, slashIndex);
    const rest = recordId.substring(slashIndex + 1);

    const colonIndex = rest.indexOf(':');
    if (colonIndex === -1) {
      return null;
    }

    const type = rest.substring(0, colonIndex);
    const value = rest.substring(colonIndex + 1);

    if (!name || !type || !value) {
      return null;
    }

    return { name, type, value };
  }

  /**
   * Flatten an RRSet into individual DnsRecordInfo entries.
   * Each record value becomes a separate entry with a composed recordId.
   */
  private flattenRRSet(rrset: RRSet, zoneId: string): DnsRecordInfo[] {
    return rrset.records.map((record) => ({
      recordId: this.composeRecordId(rrset.name, rrset.type, record.value),
      zoneId,
      type: rrset.type as DnsRecordType,
      name: rrset.name,
      value: record.value,
      ttl: rrset.ttl ?? 0,
      labels: rrset.labels,
    }));
  }

  private mapZone(zone: Zone): DnsZoneInfo {
    return {
      zoneId: zone.id.toString(),
      name: zone.name,
      ttl: zone.ttl,
      recordCount: zone.record_count,
      status: zone.status,
    };
  }
}

/**
 * Hetzner rejects an unquoted TXT value outright: *"TXT records must be fully
 * escaped with double quotes"*. It is the API's rule, not the protocol's, so it
 * is applied here rather than pushed onto every caller — a mail driver should
 * not have to know which DNS vendor is underneath.
 *
 * Values past 255 characters are split as the protocol requires: a TXT record
 * is a sequence of strings, each at most 255 bytes, and a receiver joins them
 * with nothing. DKIM keys are routinely longer than that, so a single quoted
 * blob would be rejected or silently truncated.
 */
const ESCAPED_QUOTE = String.raw`\"`;

export function quoteTxtValue(value: string): string {
  const raw = value.trim();
  // Already escaped — one quoted string or several. Leave it exactly as it is;
  // re-quoting would embed the quotes in the published value.
  if (/^"([^"]*)"(\s+"([^"]*)")*$/.test(raw)) return raw;

  const chunks = raw.match(/.{1,255}/gs) ?? [raw];
  return chunks
    .map((chunk) => `"${chunk.replaceAll('"', ESCAPED_QUOTE)}"`)
    .join(' ');
}

/** Quote only TXT; every other type is passed through untouched. */
function txtSafe(type: string, value: string): string {
  return type === 'TXT' ? quoteTxtValue(value) : value;
}
