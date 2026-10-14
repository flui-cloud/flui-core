import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { CONSOLE_WINDOW_MINUTES } from '../utils/identity-console-gate.core';

export class OpenIdentityConsoleDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    default: CONSOLE_WINDOW_MINUTES.default,
    minimum: CONSOLE_WINDOW_MINUTES.min,
    maximum: CONSOLE_WINDOW_MINUTES.max,
    description:
      'How long the console stays reachable before it closes by itself.',
  })
  @IsOptional()
  @IsInt()
  @Min(CONSOLE_WINDOW_MINUTES.min)
  @Max(CONSOLE_WINDOW_MINUTES.max)
  minutes?: number;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    description: 'Why it is being opened. Kept in the audit log.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class IdentityConsoleStatusDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: ['open', 'closed'],
    description:
      'closed: the console is not reachable from outside (redirected to the dashboard, or 403 when no dashboard address is known); sign-in is unaffected. open: reachable until `openUntil`.',
  })
  state: 'open' | 'closed';

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  openUntil: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  openedAt: string | null;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty({ nullable: true, description: 'Who opened it.' })
  openedBy: string | null;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ nullable: true, description: 'Why it was opened.' })
  reason: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Whether the cluster matches `state`. False means the last attempt to apply it failed and is retried every minute; see `lastError`.',
  })
  enforced: boolean;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty({
    type: [String],
    description: 'The public names the refusal was last applied on.',
  })
  hosts: string[];

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty({
    nullable: true,
    description:
      'While closed, where a visitor of the console is sent. Null while open, or when it answers 403 because no dashboard address is known.',
  })
  redirectTo: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  lastAppliedAt: string | null;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ nullable: true })
  lastError: string | null;
}
