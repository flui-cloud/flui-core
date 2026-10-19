import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RecommendedProviderDto {
  @ApiProperty({ description: 'Provider key', example: 'scaleway' })
  key: string;

  @ApiProperty({ description: 'Human-readable label', example: 'Scaleway' })
  label: string;

  @ApiProperty({
    description: 'Why this provider is recommended',
    example: 'EU inference on the credential you already use for your servers',
  })
  reason: string;

  @ApiProperty({
    description: 'Version-pinned model id preselected for this provider',
    example: 'deepseek-v4-flash-0731',
  })
  defaultModel: string;
}

export class RecommendedModelDto {
  @ApiProperty({ description: 'Exact, version-pinned model id' })
  model: string;

  @ApiProperty({ description: 'Short human description shown in the picker' })
  description: string;

  @ApiPropertyOptional({
    description: 'Per-provider default model (one per group)',
  })
  isDefault?: boolean;

  @ApiPropertyOptional({
    description:
      'Short human caveat badge, e.g. "Not recommended on free plan"',
  })
  note?: string;

  @ApiPropertyOptional({
    description:
      'Whether the model requires a paid plan. Unused by the dashboard — the human-facing signal is `note`.',
  })
  requiresPaidPlan?: boolean;
}

export class RecommendationGroupDto {
  @ApiProperty({ description: 'Group key', example: 'scaleway' })
  key: string;

  @ApiPropertyOptional({
    description:
      'Native provider name to match against InferenceProviderInfoDto.provider',
  })
  matchProvider?: string;

  @ApiPropertyOptional({
    description:
      "BYO host to match against a connection's baseUrl host (e.g. 'api.mistral.ai')",
  })
  matchConnectionHost?: string;

  @ApiProperty({ type: [RecommendedModelDto] })
  models: RecommendedModelDto[];
}

export class AssistantRecommendationsDto {
  @ApiProperty({
    type: RecommendedProviderDto,
    description:
      'The absolute recommended provider+model across everything (preselect + new-install messaging)',
  })
  recommendedProvider: RecommendedProviderDto;

  @ApiProperty({ type: [RecommendationGroupDto] })
  groups: RecommendationGroupDto[];
}
