import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * What the door and the countdown need, and nothing else.
 *
 * The tenancy's namespace and its synthetic address used to travel here. No
 * caller ever showed them, and a public, unauthenticated response is the last
 * place to spell out how a tenancy is built or what address stands for a guest.
 */
export class SandboxSessionDto {
  @ApiProperty({
    example: true,
    description:
      'Whether the guest holds an area yet. False while they have only looked around: the first deploy takes one.',
  })
  hasArea: boolean;

  @ApiProperty({
    example: '2026-08-16T09:30:00.000Z',
    nullable: true,
    type: String,
  })
  expiresAt: string | null;

  @ApiProperty({
    example: 86_400,
    description:
      'Seconds left. The countdown is the only channel the sandbox has — there is no email to warn anyone.',
  })
  secondsRemaining: number;

  @ApiProperty({
    example: 168,
    description: 'How long the area itself lasts.',
  })
  ttlHours: number;

  @ApiProperty({
    example: 24,
    description:
      'How long what the guest deploys lasts, which is the shorter of the two and the one that costs. Served rather than assumed, so the screen that states the rule and the sweep that enforces it cannot end up saying different numbers.',
  })
  workloadTtlHours: number;

  @ApiProperty({
    example: 'https://try.flui.cloud',
    description:
      'Where this tenancy is opened. Present on the session too, so a visitor coming back can be sent straight in instead of claiming another one.',
  })
  loginUrl: string;
}
