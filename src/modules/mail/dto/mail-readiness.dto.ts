import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MailReadinessStepDto {
  @ApiProperty({
    example: 'credential',
    description:
      'Stable across providers so a client can key off it: credential, domain, dns, verification.',
  })
  id: string;

  @ApiProperty({
    enum: ['satisfied', 'automatable', 'manual', 'pending'],
    description:
      'automatable — Flui can do this itself. manual — only a person can, in the provider console. ' +
      'pending — under way at the provider, not an error.',
  })
  status: string;

  @ApiPropertyOptional({
    example: 'permission_denied',
    description:
      "The provider's own machine-readable explanation, when it gives one.",
  })
  reason?: string;

  @ApiPropertyOptional({
    description: 'What a person has to do. Present when status is manual.',
  })
  action?: string;

  @ApiPropertyOptional({ description: 'Where they do it.' })
  consoleUrl?: string;
}

export class MailReadinessDto {
  @ApiProperty({ example: 'scaleway-tem' })
  provider: string;

  @ApiProperty({
    description:
      'True only when every step is satisfied. Pending is not ready.',
  })
  ready: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The provider project the calls were scoped to. Shown because a domain registered under ' +
      'another project comes back as "no domains" rather than as a mismatch.',
  })
  projectId?: string | null;

  @ApiProperty({ type: [MailReadinessStepDto] })
  steps: MailReadinessStepDto[];
}
