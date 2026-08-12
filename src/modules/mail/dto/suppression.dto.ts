import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SuppressionDto {
  @ApiProperty({ example: 'someone@example.com' })
  address: string;

  @ApiProperty({ enum: ['bounce', 'complaint', 'unsubscribe', 'manual'] })
  reason: string;

  @ApiProperty({
    enum: ['all', 'bulk'],
    description:
      '`all` stops every message; `bulk` stops one-to-many mail only, so someone who left a ' +
      'mailing list still receives the password reset they asked for.',
  })
  scope: string;

  @ApiProperty({
    description: "When sending stopped — the provider's timestamp, not ours.",
  })
  at: string;

  @ApiPropertyOptional()
  source?: string;

  @ApiPropertyOptional({
    description: "The provider's own words. Never body content.",
  })
  detail?: string;
}
