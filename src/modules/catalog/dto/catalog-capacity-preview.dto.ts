import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ResourceOverridesDto } from './resource-overrides.dto';

/**
 * Request body for POST /catalog/:slug/capacity-preview. Carries the exact
 * options + overrides the deploy wizard will install with, so the preview's
 * footprint is computed by the same code path as the install capacity gate.
 */
export class CatalogCapacityPreviewDto {
  @ApiProperty({ description: 'Target cluster UUID' })
  @IsUUID()
  clusterId: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'boolean' },
    description:
      'Install-time feature toggles (spec.options[].key → enabled), exactly as they will be passed to install. Option-gated components count toward the footprint only when enabled.',
  })
  @IsOptional()
  @IsObject()
  options?: Record<string, boolean>;

  @ApiPropertyOptional({
    type: ResourceOverridesDto,
    description:
      'Resource overrides to fold into the footprint. Honored only for non-composed apps (mirrors the install gate); ignored for composed apps whose components always deploy at manifest defaults.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ResourceOverridesDto)
  resourceOverrides?: ResourceOverridesDto;
}
