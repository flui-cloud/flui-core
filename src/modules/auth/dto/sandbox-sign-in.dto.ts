import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class ConnectSignInProviderDto {
  @ApiProperty({
    description:
      'The OAuth client ID GitHub or Google issued for this demo. Public: it travels in every sign-in redirect.',
    example: 'Iv23liExampleClientId',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(/^\S+$/, { message: 'clientId must not contain spaces' })
  @Sensitivity(Sensitivity.PUBLIC)
  clientId: string;

  @ApiProperty({
    description:
      'The OAuth client secret. Handed to the identity provider, which keeps it encrypted; Flui stores, logs and returns nothing of it.',
    writeOnly: true,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  @Sensitivity(Sensitivity.CREDENTIAL)
  clientSecret: string;
}

export class SignInProviderStatusDto {
  @ApiProperty({ enum: ['github', 'google'] })
  @Sensitivity(Sensitivity.PUBLIC)
  provider: 'github' | 'google';

  @ApiProperty({ example: 'GitHub' })
  @Sensitivity(Sensitivity.PUBLIC)
  name: string;

  @ApiProperty({
    description: 'Whether the identity provider holds this sign-in now.',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  connected: boolean;

  @ApiPropertyOptional({
    enum: ['flui', 'environment', 'identity-provider'],
    nullable: true,
    description:
      '`environment` while it still runs on the deprecated SANDBOX_*_CLIENT_* variables, which keep the secret in plain configuration. `identity-provider` when the identity provider still holds one those variables created after they were removed: connecting it again takes it over.',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  source: 'flui' | 'environment' | 'identity-provider' | null;

  @ApiPropertyOptional({ nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  clientId: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  @Sensitivity(Sensitivity.PUBLIC)
  connectedAt: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Who connected it or last gave it new credentials.',
  })
  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  connectedBy: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'date-time' })
  @Sensitivity(Sensitivity.PUBLIC)
  disconnectedAt: string | null;

  @ApiProperty({
    description: 'Whether its button shows on the sign-in page.',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  onSignInPage: boolean;
}

export class SignInProvidersDto {
  @ApiProperty({
    description:
      'Whether this installation is a demo. GitHub and Google sign-in can only be connected on one.',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  demo: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The callback (redirect) URL to register on the GitHub OAuth app or the Google OAuth client.',
    example:
      'https://auth.demo.example.com/ui/login/login/externalidp/callback',
  })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER, { screenOnly: true })
  callbackUrl: string | null;

  @ApiProperty({ type: [SignInProviderStatusDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  providers: SignInProviderStatusDto[];
}
