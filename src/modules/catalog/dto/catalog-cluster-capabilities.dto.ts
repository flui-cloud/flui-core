import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class CatalogClusterCapabilitiesDto {
  @ApiProperty()
  clusterId: string;

  @ApiProperty({
    description:
      'Whether a DNS zone is assigned to the cluster. Required for auto-assigned FQDNs.',
  })
  hasDnsZone: boolean;

  @ApiProperty({
    description:
      'Whether a wildcard TLS issuer is configured (certificateProvider set + wildcardCertificate=true). Required for auto-issued certificates on install.',
  })
  hasWildcardIssuer: boolean;

  @ApiProperty({
    description:
      'True when both hasDnsZone and hasWildcardIssuer are true. When true, the install flow can auto-assign {install-slug}.{zoneName} with TLS without the user specifying a domain.',
  })
  canAutoAssignDomain: boolean;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER, { screenOnly: true })
  @ApiPropertyOptional({
    description: 'Zone name (e.g. "flui.cloud"). Present when hasDnsZone=true.',
  })
  zoneName?: string;

  @ApiPropertyOptional({
    enum: CertificateProvider,
    description:
      'Configured certificate provider. Present when hasWildcardIssuer=true.',
  })
  certificateProvider?: CertificateProvider;

  @ApiPropertyOptional({
    description:
      'Preview of the FQDN pattern that will be used for auto-assigned installs. Example: "{install-slug}.flui.cloud". Present when canAutoAssignDomain=true.',
  })
  autoFqdnTemplate?: string;

  @ApiProperty({
    description:
      'True when this cluster supports installing apps with exposure=internal. Requires DNS zone + wildcard issuer Ready + the *.internal.<zone> wildcard DNS record provisioned. When false, the FE MUST hide the "internal" exposure option in the create-app wizard and disable the install button on catalog apps that default to internal (e.g. pgweb).',
  })
  hasInternalHosting: boolean;

  @ApiPropertyOptional({
    description:
      'List of missing prerequisites when hasInternalHosting=false. Lets the FE show a precise message ("DNS zone missing", "wildcard issuer not ready", ...) and link to the configuration step. Present (possibly empty) only when hasInternalHosting=false; omitted when true.',
    enum: ['dns_zone', 'wildcard_issuer', 'internal_wildcard_dns'],
    isArray: true,
  })
  internalHostingMissing?: Array<
    'dns_zone' | 'wildcard_issuer' | 'internal_wildcard_dns'
  >;

  @ApiPropertyOptional({
    description:
      'Preview of the host pattern used for internal apps on this cluster. Example: "{slug}.internal.flui.cloud". Present when hasInternalHosting=true. Use it to render the "Open" button URL together with application.internalUrl from ApplicationResponseDto.',
  })
  internalHostTemplate?: string;
}
