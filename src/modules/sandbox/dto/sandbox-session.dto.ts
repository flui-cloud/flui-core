import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * What the door and the countdown need, and nothing else.
 *
 * The tenancy's namespace and its synthetic address used to travel here. No
 * caller ever showed them, and a public, unauthenticated response is the last
 * place to spell out how a tenancy is built or what address stands for a guest.
 */
export class SandboxSessionDto {
  @ApiProperty({ example: '2026-08-16T09:30:00.000Z' })
  expiresAt: string;

  @ApiProperty({
    example: 86_400,
    description:
      'Seconds left. The countdown is the only channel the sandbox has — there is no email to warn anyone.',
  })
  secondsRemaining: number;

  @ApiProperty({ example: 24 })
  ttlHours: number;

  @ApiProperty({
    example: 'https://try.flui.cloud',
    description:
      'Where this tenancy is opened. Present on the session too, so a visitor coming back can be sent straight in instead of claiming another one.',
  })
  loginUrl: string;
}

export class SandboxClaimResultDto extends SandboxSessionDto {
  @ApiPropertyOptional({
    description:
      'API key for this tenancy, returned once and never recoverable. The browser is already signed in by the session cookie set alongside it; this copy exists so the same tenancy can be driven from the CLI. It expires with the tenancy. Absent when an existing tenancy is resumed rather than assigned.',
  })
  apiKey?: string;

  @ApiProperty({
    example: false,
    description:
      'True when the caller already held a live tenancy and was given it back instead of a new one.',
  })
  resumed: boolean;
}

export class SandboxSaveRequestDto {
  @ApiProperty({
    example: 'you@example.com',
    description:
      'Where to send the way back. Kept for nothing else, and gone with the tenancy.',
  })
  email: string;
}

export class SandboxSaveResultDto {
  @ApiProperty({ example: true })
  sent: boolean;

  @ApiPropertyOptional({
    example: 'not_configured',
    description:
      'Why it did not go, when it did not: `not_configured` (this instance cannot send mail) or `send_failed`.',
  })
  reason?: string;

  @ApiProperty({
    example: '2026-08-19T09:30:00.000Z',
    description: 'When the link stops working, which is when the tenancy does.',
  })
  expiresAt: string;
}
