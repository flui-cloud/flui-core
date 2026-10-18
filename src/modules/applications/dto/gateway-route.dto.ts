import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  GatewayAuthPolicyDto,
  GatewayRateLimitPolicyDto,
} from '../../dns/dto/gateway-config.dto';
import { IsGatewayCidrList } from '../../dns/validators/gateway-cidr.validator';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';
import { CertificateStatus } from '../../providers/interfaces/certificate-provider.interface';
import { EndpointType } from '../../dns/enums/endpoint-type.enum';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { EndpointSyncDto } from '../../dns/dto/endpoint-sync.dto';
import { CertificatePhaseDto } from '../../dns/dto/certificate-phase.dto';

export class GatewayRouteDto {
  @ApiProperty({ description: 'Endpoint id backing this route.' })
  @Sensitivity(Sensitivity.PUBLIC)
  endpointId: string;

  @ApiProperty({ description: 'Route hostname (fqdn).' })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER, { screenOnly: true })
  host: string;

  @ApiProperty({ description: 'PathPrefix the route matches.', example: '/' })
  @Sensitivity(Sensitivity.PUBLIC)
  path: string;

  @ApiProperty({ description: 'Application id owning the route.' })
  @Sensitivity(Sensitivity.PUBLIC)
  applicationId: string;

  @ApiProperty({ description: 'Backing service, `<name>:<port>`.' })
  @Sensitivity(Sensitivity.PUBLIC)
  service: string;

  @ApiProperty({ enum: EndpointType })
  @Sensitivity(Sensitivity.PUBLIC)
  endpointType: EndpointType;

  @ApiProperty({ description: 'True when HTTPS is active on the route.' })
  @Sensitivity(Sensitivity.PUBLIC)
  tlsEnabled: boolean;

  @ApiPropertyOptional({ enum: CertificateStatus })
  @Sensitivity(Sensitivity.PUBLIC)
  certificateStatus?: CertificateStatus | null;

  @ApiPropertyOptional({ type: CertificatePhaseDto })
  @Sensitivity(Sensitivity.PUBLIC)
  certificatePhase?: CertificatePhaseDto;

  @ApiPropertyOptional({ type: GatewayAuthPolicyDto })
  @Sensitivity(Sensitivity.PUBLIC)
  auth?: GatewayAuthPolicyDto | null;

  @ApiPropertyOptional({ type: GatewayRateLimitPolicyDto })
  @Sensitivity(Sensitivity.PUBLIC)
  rateLimit?: GatewayRateLimitPolicyDto | null;

  @ApiPropertyOptional({ type: [String] })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER, { screenOnly: true })
  allowIps?: string[] | null;

  @ApiProperty({ enum: ReconciliationStatus })
  @Sensitivity(Sensitivity.PUBLIC)
  reconciliationStatus: ReconciliationStatus;

  @ApiPropertyOptional({ description: 'Last reconciliation error, if any.' })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  errorMessage?: string | null;
}

export class GatewayRouteSyncDto extends GatewayRouteDto {
  @ApiProperty({ type: EndpointSyncDto })
  @Sensitivity(Sensitivity.PUBLIC)
  sync: EndpointSyncDto;
}

export class ClusterGatewayRouteDto extends GatewayRouteDto {
  @ApiPropertyOptional({ description: 'Owning application name.' })
  @Sensitivity(Sensitivity.PUBLIC)
  applicationName?: string | null;

  @ApiPropertyOptional({ description: 'Owning application slug.' })
  @Sensitivity(Sensitivity.PUBLIC)
  applicationSlug?: string | null;
}

export class AddGatewayRouteDto {
  @ApiProperty({
    description: 'Hostname for the new route, e.g. api.example.com.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(253)
  @Matches(
    /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
    {
      message: 'host must be a valid fully-qualified domain name',
    },
  )
  host: string;

  @ApiPropertyOptional({
    description: 'PathPrefix the route matches. Defaults to "/".',
    example: '/api',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\/[A-Za-z0-9\-._~%/]*$/, {
    message: 'path must start with "/" and contain URL path characters only',
  })
  path?: string;

  @ApiPropertyOptional({
    description:
      'Cluster DNS zone to create the record in. Auto-matched from the host when omitted; unmatched hosts are BYOD (you manage DNS externally).',
  })
  @IsOptional()
  @IsUUID()
  clusterDnsZoneId?: string;

  @ApiPropertyOptional({
    description: 'Issue a TLS certificate. Default true.',
  })
  @IsOptional()
  @IsBoolean()
  certificateRequired?: boolean;

  @ApiPropertyOptional({ type: GatewayAuthPolicyDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GatewayAuthPolicyDto)
  auth?: GatewayAuthPolicyDto;

  @ApiPropertyOptional({ type: GatewayRateLimitPolicyDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GatewayRateLimitPolicyDto)
  rateLimit?: GatewayRateLimitPolicyDto;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsGatewayCidrList()
  allowIps?: string[];
}

/**
 * Partial policy update. A field left undefined is unchanged; an explicit
 * null clears that policy.
 */
export class SetGatewayPolicyDto {
  @ApiPropertyOptional({
    description: 'PathPrefix the route matches. Null resets to "/".',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\/[A-Za-z0-9\-._~%/]*$/, {
    message: 'path must start with "/" and contain URL path characters only',
  })
  path?: string | null;

  @ApiPropertyOptional({
    type: GatewayAuthPolicyDto,
    description: 'SSO policy. Null disables the auth gate.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => GatewayAuthPolicyDto)
  auth?: GatewayAuthPolicyDto | null;

  @ApiPropertyOptional({
    type: GatewayRateLimitPolicyDto,
    description: 'Rate limit. Null removes it.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => GatewayRateLimitPolicyDto)
  rateLimit?: GatewayRateLimitPolicyDto | null;

  @ApiPropertyOptional({
    type: [String],
    description: 'CIDR allowlist. Null (or empty) removes the IP filter.',
  })
  @IsOptional()
  @IsGatewayCidrList()
  allowIps?: string[] | null;
}

export class CompiledGatewayMiddlewareDto {
  @ApiProperty()
  name: string;

  @ApiProperty({
    description: 'Traefik Middleware CRD manifest, as applied to the cluster.',
    type: Object,
  })
  manifest: Record<string, unknown>;
}

export class CompiledGatewayRouteDto {
  @ApiProperty({ description: 'Endpoint id backing this route.' })
  endpointId: string;

  @ApiProperty({ description: 'PathPrefix the Ingress rule matches.' })
  path: string;

  @ApiProperty({ type: [CompiledGatewayMiddlewareDto] })
  middlewares: CompiledGatewayMiddlewareDto[];

  @ApiProperty({
    description:
      'Value of the traefik router.middlewares Ingress annotation (empty when no policies).',
  })
  middlewareAnnotation: string;
}

export class GatewayStatusDto {
  @ApiProperty({ description: 'Routes on the application.' })
  total: number;

  @ApiProperty({ description: 'Routes fully reconciled.' })
  synced: number;

  @ApiProperty({ type: [GatewayRouteDto] })
  routes: GatewayRouteDto[];
}
