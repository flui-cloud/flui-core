import { DnsProvider } from '../enums/dns-provider.enum';

export enum CertificateStatus {
  PENDING = 'pending',
  ISSUING = 'issuing',
  VALID = 'valid',
  EXPIRED = 'expired',
  FAILED = 'failed',
}

export interface CertificateInfo {
  domain: string;
  issuer: string;
  status: CertificateStatus;
  notBefore?: Date;
  notAfter?: Date;
  serialNumber?: string;
}

export interface CertificateIssuerConfig {
  email: string;
  server: string;
  privateKeySecretRef: string;
  solverType: 'dns01' | 'http01';
  dnsProvider?: DnsProvider;
}

/** One dns01 solver of a ClusterIssuer: a DNS provider and the zones it answers for. */
export interface Dns01SolverSpec {
  dnsProvider: DnsProvider;
  zoneNames: string[];
}

export type Dns01Credential =
  | { kind: 'api_token'; token: string }
  | { kind: 'access_key_pair'; accessKey: string; secretKey: string };

export interface CertificateManifestConfig {
  name: string;
  namespace: string;
  domains: string[];
  issuerName: string;
  secretName: string;
}

export interface ICertificateProvider {
  generateClusterIssuerManifest(config: CertificateIssuerConfig): string;

  generateCertificateManifest(config: CertificateManifestConfig): string;

  validateConfiguration(config: CertificateIssuerConfig): {
    valid: boolean;
    errors: string[];
  };
}
