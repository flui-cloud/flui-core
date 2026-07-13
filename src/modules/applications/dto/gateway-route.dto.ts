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
  GATEWAY_CIDR_MESSAGE,
  GATEWAY_CIDR_REGEX,
  GatewayAuthPolicyDto,
  GatewayRateLimitPolicyDto,
} from '../../dns/dto/gateway-config.dto';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';
import { CertificateStatus } from '../../providers/interfaces/certificate-provider.interface';
import { EndpointType } from '../../dns/enums/endpoint-type.enum';

export class GatewayRouteDto {
  @ApiProperty({ description: 'Endpoint id backing this route.' })
  endpointId: string;

  @ApiProperty({ description: 'Route hostname (fqdn).' })
  host: string;

  @ApiProperty({ description: 'PathPrefix the route matches.', example: '/' })
  path: string;

  @ApiProperty({ description: 'Application id owning the route.' })
  applicationId: string;

  @ApiProperty({ description: 'Backing service, `<name>:<port>`.' })
  service: string;

  @ApiProperty({ enum: EndpointType })
  endpointType: EndpointType;

  @ApiProperty({ description: 'True when HTTPS is active on the route.' })
  tlsEnabled: boolean;

  @ApiPropertyOptional({ enum: CertificateStatus })
  certificateStatus?: CertificateStatus | null;

  @ApiPropertyOptional({ type: GatewayAuthPolicyDto })
  auth?: GatewayAuthPolicyDto | null;

  @ApiPropertyOptional({ type: GatewayRateLimitPolicyDto })
  rateLimit?: GatewayRateLimitPolicyDto | null;

  @ApiPropertyOptional({ type: [String] })
  allowIps?: string[] | null;

  @ApiProperty({ enum: ReconciliationStatus })
  reconciliationStatus: ReconciliationStatus;

  @ApiPropertyOptional({ description: 'Last reconciliation error, if any.' })
  errorMessage?: string | null;
}

export class ClusterGatewayRouteDto extends GatewayRouteDto {
  @ApiPropertyOptional({ description: 'Owning application name.' })
  applicationName?: string | null;

  @ApiPropertyOptional({ description: 'Owning application slug.' })
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
  @Matches(GATEWAY_CIDR_REGEX, { each: true, message: GATEWAY_CIDR_MESSAGE })
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
  @Matches(GATEWAY_CIDR_REGEX, { each: true, message: GATEWAY_CIDR_MESSAGE })
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
