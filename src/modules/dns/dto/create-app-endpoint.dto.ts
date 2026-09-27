import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';
import { CertChallenge } from '../enums/cert-challenge.enum';
import { HostnameMode } from '../enums/hostname-mode.enum';
import { EndpointType } from '../enums/endpoint-type.enum';

export class CreateAppEndpointDto {
  @ApiProperty({
    description:
      'ID of the application to expose. K8s service name, namespace, and port are resolved automatically from the application.',
  })
  @IsUUID()
  applicationId: string;

  @ApiPropertyOptional({
    enum: EndpointType,
    description:
      'Endpoint type. `public` (default) is the standard endpoint with public DNS + per-app cert + Ingress. `internal` is reachable only via the cluster-wide ForwardAuth gateway: requires the cluster to have internal hosting capability (DNS zone + wildcard issuer) AND a running Auth Proxy install. If omitted, derived from the application exposure.',
  })
  @IsOptional()
  @IsEnum(EndpointType)
  endpointType?: EndpointType;

  @ApiPropertyOptional({
    example: 'grafana.staging.flui.cloud',
    description:
      'Full FQDN for the endpoint. If omitted, generated as {serviceName}.{clusterName}.{zoneName}',
  })
  @IsOptional()
  @IsString()
  fqdn?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'Path prefix this endpoint answers for on its host (default `/`). A host can carry several paths, all owned by applications of one project.',
  })
  @IsOptional()
  @IsString()
  routePath?: string;

  @ApiPropertyOptional({
    description:
      'ID of the ClusterDnsZone to use. If omitted, DNS management is BYOD (user manages DNS externally).',
  })
  @IsOptional()
  @IsUUID()
  clusterDnsZoneId?: string;

  @ApiPropertyOptional({
    enum: CertificateProvider,
    description:
      'Certificate provider for this endpoint. Overrides the cluster DNS zone setting. ' +
      'Use LETS_ENCRYPT_STAGING to test before switching to LETS_ENCRYPT for production.',
  })
  @IsOptional()
  @IsEnum(CertificateProvider)
  certificateProvider?: CertificateProvider;

  @ApiPropertyOptional({
    default: true,
    description: 'Whether to provision a TLS certificate',
  })
  @IsOptional()
  @IsBoolean()
  certificateRequired?: boolean;

  @ApiPropertyOptional({
    enum: CertChallenge,
    description:
      'ACME challenge type. HTTP_01 works without DNS provider integration. ' +
      'DNS_01 requires a configured cluster DNS zone and supports wildcard certs. ' +
      'If omitted, derived from the cluster configuration.',
  })
  @IsOptional()
  @IsEnum(CertChallenge)
  certChallenge?: CertChallenge;

  @ApiPropertyOptional({
    enum: HostnameMode,
    description:
      'Hostname source. IP uses nip.io against the cluster master IP (no DNS provider needed). ' +
      'DOMAIN uses a real DNS zone. IP forces HTTP_01. If omitted, derived from the cluster configuration.',
  })
  @IsOptional()
  @IsEnum(HostnameMode)
  hostnameMode?: HostnameMode;

  @ApiPropertyOptional({
    description:
      'Bind this endpoint to an existing SAN certificate. The fqdn must be one of its dnsNames. ' +
      'When set, the endpoint reuses the SAN master TLS Secret and skips per-host cert emission. ' +
      'Mutually exclusive with the wildcard tiered flow (wildcard binding is skipped when sanCertificateId is set).',
  })
  @IsOptional()
  @IsUUID()
  sanCertificateId?: string;
}
