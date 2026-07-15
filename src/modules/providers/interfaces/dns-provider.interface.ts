export enum DnsRecordType {
  A = 'A',
  AAAA = 'AAAA',
  CNAME = 'CNAME',
  TXT = 'TXT',
  MX = 'MX',
  SRV = 'SRV',
}

export interface DnsZoneInfo {
  zoneId: string;
  name: string;
  ttl: number;
  recordCount: number;
  status: string;
}

export interface DnsRecordInfo {
  recordId: string;
  zoneId: string;
  type: DnsRecordType;
  name: string;
  value: string;
  ttl: number;
  labels?: Record<string, string>;
}

export interface CreateDnsRecordConfig {
  zoneId: string;
  type: DnsRecordType;
  name: string;
  value: string;
  ttl?: number;
  labels?: Record<string, string>;
}

export interface UpdateDnsRecordConfig {
  recordId: string;
  zoneId: string;
  type: DnsRecordType;
  name: string;
  value: string;
  ttl?: number;
  /** Re-applied on write. Without this an updated record keeps whatever
   *  attribution it had — and label-predicated cleanup can never match it. */
  labels?: Record<string, string>;
}

export interface IDnsProvider {
  listZones(): Promise<DnsZoneInfo[]>;
  getZone(zoneId: string): Promise<DnsZoneInfo | null>;
  getZoneByName(name: string): Promise<DnsZoneInfo | null>;

  listRecords(zoneId: string): Promise<DnsRecordInfo[]>;
  getRecord(zoneId: string, recordId: string): Promise<DnsRecordInfo | null>;
  createRecord(config: CreateDnsRecordConfig): Promise<DnsRecordInfo>;
  updateRecord(config: UpdateDnsRecordConfig): Promise<DnsRecordInfo>;
  deleteRecord(zoneId: string, recordId: string): Promise<void>;

  bulkCreateRecords(
    zoneId: string,
    records: CreateDnsRecordConfig[],
  ): Promise<DnsRecordInfo[]>;

  testConnection(): Promise<{ success: boolean; error?: string }>;
}
