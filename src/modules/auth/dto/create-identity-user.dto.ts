import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IdentityRole } from '../entities/user.entity';

export class CreateIdentityUserDto {
  @ApiProperty({ example: 'jane.doe@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'Jane' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  lastName: string;

  @ApiProperty({
    description:
      'When true the provider sends an invite email (requires SMTP). When false a temp password is returned in the response.',
    example: false,
  })
  @IsBoolean()
  sendInvite: boolean;

  @ApiPropertyOptional({
    description:
      'Optional temp password (used only when sendInvite=false). When omitted, a secure password is generated.',
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  tempPassword?: string;

  @ApiPropertyOptional({ enum: IdentityRole, default: IdentityRole.USER })
  @IsOptional()
  @IsEnum(IdentityRole)
  role?: IdentityRole;
}

export class CreatedIdentityUserDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ enum: IdentityRole })
  role: IdentityRole;

  @ApiPropertyOptional({
    description:
      'Returned only when sendInvite=false. Shown once — not persisted.',
  })
  tempPassword?: string;

  @ApiPropertyOptional({
    description:
      'Returned when sendInvite=true. Copyable link the user opens to set up their account (no email required). Path is configurable via OIDC_INVITE_LINK_TEMPLATE.',
  })
  inviteLink?: string;

  @ApiPropertyOptional({
    description:
      'Returned when sendInvite=true. Raw provider invite code — authoritative fallback if the link path needs adjusting.',
  })
  inviteCode?: string;
}
