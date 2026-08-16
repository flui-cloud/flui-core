import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SandboxSessionDto {
  @ApiProperty({ example: 'guest-4f2a' })
  namespace: string;

  @ApiProperty({ example: 'guest-4f2a@try.flui.cloud' })
  email: string;

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
}

export class SandboxClaimResultDto extends SandboxSessionDto {
  @ApiPropertyOptional({
    description:
      'API key for this tenancy, returned once and never recoverable. The browser is already signed in by the session cookie set alongside it; this copy exists so the same tenancy can be driven from the CLI. It expires with the tenancy.',
  })
  apiKey?: string;

  @ApiProperty({ example: 'https://try.flui.cloud' })
  loginUrl: string;
}
