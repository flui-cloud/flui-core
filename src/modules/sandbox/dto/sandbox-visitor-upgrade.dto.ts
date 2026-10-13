import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class VisitorUpgradeProviderDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['github', 'google'] })
  provider: 'github' | 'google';

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: 'GitHub' })
  name: string;
}

export class VisitorUpgradeProvidersDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    type: [VisitorUpgradeProviderDto],
    description: 'The sign-ins connected on this demo, and only those.',
  })
  providers: VisitorUpgradeProviderDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'Whether registering with an email is open.',
  })
  email: boolean;
}

export class VisitorUpgradeIdpRequestDto {
  @ApiProperty({ enum: ['github', 'google'] })
  @IsIn(['github', 'google'])
  provider: 'github' | 'google';

  @ApiPropertyOptional({
    description:
      'A dashboard path to come back to, such as `/applications`. Anything that is not a path of the dashboard is ignored.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  returnTo?: string;
}

export class VisitorUpgradeIdpDto {
  @Sensitivity(Sensitivity.CREDENTIAL, { conditional: true })
  @ApiProperty({
    description:
      'Where the browser goes to sign in with GitHub or Google. Single use.',
  })
  authUrl: string;
}

export class VisitorUpgradeFinishRequestDto {
  @ApiProperty({
    description:
      'The `flow` the dashboard was sent back with. Single use, and only for the visitor that started the sign-in.',
  })
  @IsString()
  @Length(16, 128)
  flow: string;
}

export class VisitorUpgradeFinishDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: ['upgraded', 'signin-as-existing', 'refused'],
    description:
      '`upgraded`: the visitor is an account now, same user. `signin-as-existing`: the identity belongs to an account; sign in to it (the visit was merged into it, or `linkNonce` merges it). `refused`: see `reason`.',
  })
  outcome: 'upgraded' | 'signin-as-existing' | 'refused';

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    nullable: true,
    enum: ['blocked', 'expired', 'failed'],
  })
  reason: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  returnTo: string | null;

  @Sensitivity(Sensitivity.CREDENTIAL, { conditional: true })
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Present when the account must sign in first: pass it to `POST /sandbox/visitor/link` once signed in.',
  })
  linkNonce: string | null;
}

export class VisitorLinkIntentDto {
  @Sensitivity(Sensitivity.CREDENTIAL, { conditional: true })
  @ApiProperty({
    description:
      'Single use, for 15 minutes. Kept by the browser while the visitor registers or signs in, then sent to `POST /sandbox/visitor/link`.',
  })
  nonce: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  expiresAt: string;
}

export class VisitorLinkIntentRequestDto {
  @ApiPropertyOptional({ description: 'A dashboard path to come back to.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  returnTo?: string;
}

export class VisitorLinkRequestDto {
  @ApiProperty()
  @IsString()
  @Length(16, 128)
  nonce: string;
}

export class VisitorLinkDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['linked'] })
  outcome: 'linked';

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  returnTo: string | null;
}
