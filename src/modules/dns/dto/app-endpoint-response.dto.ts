import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DnsRecordType } from '../../providers/interfaces/dns-provider.interface';
import { CertificateStatus } from '../../providers/interfaces/certificate-provider.interface';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';
import { EndpointType } from '../enums/endpoint-type.enum';
import { CertChallenge } from '../enums/cert-challenge.enum';
import { HostnameMode } from '../enums/hostname-mode.enum';
import { GatewayConfigDto } from './gateway-config.dto';

export class AppEndpointResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  clusterId: string;

  @ApiPropertyOptional()
  applicationId: string;

  @ApiPropertyOptional()
  clusterDnsZoneId: string;

  @ApiProperty({
    enum: EndpointType,
    default: EndpointType.PUBLIC,
    description:
      '"public" = standard endpoint with public DNS + per-app cert + Ingress on the cluster public hostname. "internal" = ForwardAuth-gated endpoint on the cluster wildcard `*.internal.<zone>` (no per-app DNS, no DNS / Cert tabs in the FE; reachable only from the dashboard). The frontend MUST switch the rendering of the endpoint card based on this discriminator.',
  })
  endpointType: EndpointType;

  @ApiProperty({
    enum: HostnameMode,
    description:
      'Hostname source. "ip" = nip.io against the cluster master IP, "domain" = real DNS zone.',
  })
  hostnameMode: HostnameMode;

  @ApiProperty({
    enum: CertChallenge,
    description:
      'ACME challenge used to issue the TLS certificate. IP-mode endpoints are always http-01.',
  })
  certChallenge: CertChallenge;

  @ApiProperty()
  fqdn: string;

  @ApiProperty()
  serviceName: string;

  @ApiProperty()
  k8sServiceName: string;

  @ApiProperty()
  k8sNamespace: string;

  @ApiProperty()
  k8sServicePort: number;

  @ApiProperty({ enum: DnsRecordType })
  dnsRecordType: DnsRecordType;

  @ApiPropertyOptional()
  dnsRecordValue: string;

  @ApiPropertyOptional()
  dnsRecordId: string;

  @ApiProperty()
  certificateRequired: boolean;

  @ApiPropertyOptional({ enum: CertificateProvider })
  certificateProvider: CertificateProvider;

  @ApiProperty()
  tlsEnabled: boolean;

  @ApiPropertyOptional({ enum: CertificateStatus })
  certificateStatus: CertificateStatus;

  @ApiPropertyOptional()
  certificateMessage: string;

  @ApiPropertyOptional()
  certificateExpiresAt: Date;

  @ApiProperty({ enum: ReconciliationStatus })
  reconciliationStatus: ReconciliationStatus;

  @ApiPropertyOptional()
  lastReconciliationAt: Date;

  @ApiPropertyOptional()
  errorMessage: string;

  @ApiPropertyOptional()
  metadata: Record<string, string>;

  @ApiPropertyOptional({
    type: GatewayConfigDto,
    description:
      'Per-route gateway policies (auth/rateLimit/allowIps/path). Null = default behavior (plain route, no policies).',
  })
  gatewayConfig: GatewayConfigDto | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
