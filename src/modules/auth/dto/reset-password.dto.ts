import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({
    description:
      'When true returns a copyable invite link to re-initialize the account. When false a fresh temp password is generated and returned.',
  })
  @IsBoolean()
  sendInvite: boolean;
}

export class ResetPasswordResultDto {
  @ApiPropertyOptional({
    description: 'Returned only when sendInvite=false. Shown once.',
  })
  tempPassword?: string;

  @ApiPropertyOptional({
    description:
      'Returned when sendInvite=true. Copyable link to re-initialize the account (no email required).',
  })
  inviteLink?: string;

  @ApiPropertyOptional({
    description: 'Returned when sendInvite=true. Raw provider invite code.',
  })
  inviteCode?: string;
}
