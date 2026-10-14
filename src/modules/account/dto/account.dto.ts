import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class UpdateAccountProfileDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: 'Ada' })
  @IsString()
  @Length(1, 200)
  firstName: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: 'Lovelace' })
  @IsString()
  @Length(1, 200)
  lastName: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    example: 'Ada Lovelace',
    description: 'Defaults to the first and last name together.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  displayName?: string;
}

export class ChangeAccountPasswordDto {
  @Sensitivity(Sensitivity.CREDENTIAL)
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  currentPassword: string;

  @Sensitivity(Sensitivity.CREDENTIAL)
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  newPassword: string;
}

export class ConfirmWithPasswordDto {
  @Sensitivity(Sensitivity.CREDENTIAL)
  @ApiProperty({ description: 'Your current password, to confirm the change.' })
  @IsString()
  @Length(1, 200)
  currentPassword: string;
}

export class StartTotpDto {
  @Sensitivity(Sensitivity.CREDENTIAL)
  @ApiPropertyOptional({
    description:
      'Your current password, to confirm the change. Required when your account has one.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  currentPassword?: string;
}

export class VerifyTotpDto {
  @Sensitivity(Sensitivity.CREDENTIAL)
  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6,8}$/, { message: 'code must be the 6 digits your app shows' })
  code: string;
}

export class AccountProfileDto {
  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty()
  userName: string;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty({ nullable: true, type: String })
  email: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  emailVerified: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: String })
  firstName: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: String })
  lastName: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: String })
  displayName: string | null;
}

export class AccountFactorDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  id: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  name: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'False while its registration was never finished.',
  })
  ready: boolean;
}

export class AccountLinkDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  idpId: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: 'GitHub' })
  provider: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  externalUserId: string;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty()
  externalUserName: string;
}

export class AccountSecurityDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Whether the account signs in with a password.' })
  password: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'An authenticator app is set up.' })
  totp: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: () => [AccountFactorDto] })
  passkeys: AccountFactorDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: () => [AccountFactorDto] })
  securityKeys: AccountFactorDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: () => [AccountLinkDto] })
  links: AccountLinkDto[];
}

export class AccountLimitsDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'A guest of the demo.' })
  guest: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Whether a linked sign-in may be removed here. A demo guest keeps the one it signed in with.',
  })
  canUnlink: boolean;
}

export class AccountOverviewDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: () => AccountProfileDto })
  profile: AccountProfileDto;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: () => AccountSecurityDto })
  security: AccountSecurityDto;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: () => AccountLimitsDto })
  limits: AccountLimitsDto;
}

export class PasswordRequirementDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: ['min-length', 'uppercase', 'lowercase', 'number', 'symbol'],
  })
  rule: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  label: string;
}

export class PasswordPolicyDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  minLength: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: () => [PasswordRequirementDto] })
  requirements: PasswordRequirementDto[];
}

export class TotpRegistrationDto {
  @Sensitivity(Sensitivity.CREDENTIAL, { conditional: true })
  @ApiProperty({
    description:
      'otpauth:// address to open in, or scan into, an authenticator app. Shown once.',
  })
  uri: string;

  @Sensitivity(Sensitivity.CREDENTIAL, { conditional: true })
  @ApiProperty({
    description: 'The same secret, to type in by hand. Shown once.',
  })
  secret: string;
}

export class AccountDoneDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  success: boolean;
}
