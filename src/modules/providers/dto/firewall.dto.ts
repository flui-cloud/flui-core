import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsIn,
  IsOptional,
  IsArray,
  ValidateNested,
  IsObject,
  Matches,
  ValidateIf,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class FirewallRuleDto {
  @ApiPropertyOptional({
    description: 'Stable rule ID (kebab-case). Generated when omitted.',
    example: 'allow-https',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Rule ID must be lowercase alphanumeric with hyphens (kebab-case)',
  })
  id?: string;

  @ApiProperty({ example: 'Allow inbound HTTPS' })
  @IsString()
  description: string;

  @ApiProperty({ enum: ['in', 'out'], example: 'in' })
  @IsIn(['in', 'out'])
  direction: 'in' | 'out';

  @ApiProperty({ enum: ['tcp', 'udp', 'icmp'], example: 'tcp' })
  @IsIn(['tcp', 'udp', 'icmp'])
  protocol: 'tcp' | 'udp' | 'icmp';

  @ApiPropertyOptional({
    description: 'Port or range (e.g. "443" or "8000-8100"). Omit for icmp.',
    example: '443',
  })
  @IsOptional()
  @IsString()
  port?: string;

  // For inbound rules, sourceIps is required
  @ApiPropertyOptional({
    type: [String],
    description: 'Source CIDRs — required for inbound rules.',
    example: ['0.0.0.0/0', '::/0'],
  })
  @ValidateIf((o) => o.direction === 'in')
  @IsArray()
  @ArrayMinSize(1, {
    message:
      'sourceIps is required for inbound rules and must contain at least one IP address (e.g., ["0.0.0.0/0", "::/0"])',
  })
  @IsString({ each: true })
  sourceIps?: string[];

  // For outbound rules, destinationIps is required
  @ApiPropertyOptional({
    type: [String],
    description: 'Destination CIDRs — required for outbound rules.',
    example: ['0.0.0.0/0', '::/0'],
  })
  @ValidateIf((o) => o.direction === 'out')
  @IsArray()
  @ArrayMinSize(1, {
    message:
      'destinationIps is required for outbound rules and must contain at least one IP address (e.g., ["0.0.0.0/0", "::/0"])',
  })
  @IsString({ each: true })
  destinationIps?: string[];
}

export class CreateFirewallDto {
  @ApiProperty({ example: 'web-tier' })
  @IsString()
  name: string;

  @ApiProperty({ type: [FirewallRuleDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FirewallRuleDto)
  rules: FirewallRuleDto[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Arbitrary key/value labels.',
    example: { env: 'prod' },
  })
  @IsOptional()
  @IsObject()
  labels?: Record<string, string>;

  @ApiPropertyOptional({
    type: [String],
    description: 'Server IDs to apply this firewall to.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  applyToServerIds?: string[];

  @ApiPropertyOptional({
    description: 'Label selector to apply this firewall to (e.g. "role=web").',
  })
  @IsOptional()
  @IsString()
  applyToLabelSelector?: string;
}

export class ProviderUpdateFirewallRulesDto {
  @ApiProperty({ description: 'Provider firewall ID to update.' })
  @IsString()
  firewallId: string;

  @ApiProperty({ type: [FirewallRuleDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FirewallRuleDto)
  rules: FirewallRuleDto[];
}

export class ProviderFirewallDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ description: 'Cloud provider key (e.g. hetzner, scaleway).' })
  provider: string;

  @ApiProperty({ type: [FirewallRuleDto] })
  rules: FirewallRuleDto[];

  @ApiProperty({
    description: 'Number of servers this firewall is applied to.',
  })
  appliedToServerCount: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { env: 'prod' },
  })
  labels: Record<string, string>;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}
