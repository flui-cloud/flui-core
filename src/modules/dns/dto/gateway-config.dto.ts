import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { IAM_ROLE, IamRole } from '../../iam/constants/iam-roles';

export const GATEWAY_MIN_ROLES: IamRole[] = Object.values(IAM_ROLE);

/** IPv4/IPv6 address or CIDR. Shape check only — Traefik validates semantics. */
export const GATEWAY_CIDR_REGEX = /^[0-9a-fA-F.:]+(\/\d{1,3})?$/;
export const GATEWAY_CIDR_MESSAGE =
  'allowIps entries must be IPv4/IPv6 addresses or CIDR ranges';

export class GatewayAuthPolicyDto {
  @ApiProperty({
    description:
      'Gate every request through Flui SSO (Traefik forwardAuth → /authz/gateway).',
  })
  @IsBoolean()
  sso: boolean;

  @ApiPropertyOptional({
    description:
      'Minimum IAM role on the application required to pass, evaluated by the PolicyEngine. Omit to allow any authenticated user.',
    enum: GATEWAY_MIN_ROLES,
  })
  @IsOptional()
  @IsIn(GATEWAY_MIN_ROLES)
  minRole?: IamRole;
}

export class GatewayRateLimitPolicyDto {
  @ApiProperty({
    description: 'Sustained requests allowed per period.',
    example: 100,
  })
  @IsInt()
  @Min(1)
  average: number;

  @ApiPropertyOptional({
    description: 'Burst capacity above the average.',
    example: 50,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  burst?: number;

  @ApiPropertyOptional({
    description: 'Averaging window as a Go duration. Defaults to 1s.',
    example: '1s',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+(ms|s|m|h)$/, {
    message: 'period must be a duration like 500ms, 1s, 1m or 1h',
  })
  period?: string;
}

export class GatewayConfigDto {
  @ApiPropertyOptional({
    description: 'PathPrefix match for the route. Defaults to "/".',
    example: '/api',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\/[A-Za-z0-9\-._~%/]*$/, {
    message: 'path must start with "/" and contain URL path characters only',
  })
  path?: string;

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

  @ApiPropertyOptional({
    description:
      'CIDR allowlist. When set, requests from any other source are rejected.',
    type: [String],
    example: ['203.0.113.0/24'],
  })
  @IsOptional()
  @IsArray()
  @Matches(GATEWAY_CIDR_REGEX, {
    each: true,
    message: GATEWAY_CIDR_MESSAGE,
  })
  allowIps?: string[];
}
