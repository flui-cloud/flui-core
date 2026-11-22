import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const PATH = /^\/[^\s?#]{0,255}$/;

export class InviteIdentityUserDto {
  @ApiProperty({ example: 'alice@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'Alice' })
  @IsString()
  @Length(1, 100)
  givenName: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  @Length(1, 100)
  familyName: string;
}

export class IdentityEnvNamesDto {
  @ApiPropertyOptional({ example: 'OIDC_ISSUER' })
  @IsOptional()
  @Matches(ENV_NAME)
  @Sensitivity(Sensitivity.PUBLIC)
  issuer?: string;

  @ApiPropertyOptional({ example: 'OIDC_CLIENT_ID' })
  @IsOptional()
  @Matches(ENV_NAME)
  @Sensitivity(Sensitivity.PUBLIC)
  clientId?: string;

  @ApiPropertyOptional({ example: 'OIDC_CLIENT_SECRET' })
  @IsOptional()
  @Matches(ENV_NAME)
  @Sensitivity(Sensitivity.PUBLIC)
  clientSecret?: string;
}

export class ConnectAppIdentityDto {
  @ApiProperty({
    description:
      'The identity install the application signs its users in with.',
  })
  @IsUUID()
  identityInstallId: string;

  @ApiProperty({
    type: [String],
    example: ['/auth/callback'],
    description:
      'Paths on the application’s address the identity server may send people back to after sign-in.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @Matches(PATH, { each: true })
  redirectPaths: string[];

  @ApiPropertyOptional({
    type: IdentityEnvNamesDto,
    description:
      'Variable names the application reads; OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET when omitted.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => IdentityEnvNamesDto)
  envNames?: IdentityEnvNamesDto;
}

export class IdentityUserDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  id: string;
  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty()
  username: string;
  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty({ nullable: true, type: String })
  email: string | null;
  @ApiProperty({ enum: ['active', 'invited', 'blocked', 'locked'] })
  @Sensitivity(Sensitivity.PUBLIC)
  state: 'active' | 'invited' | 'blocked' | 'locked';
}

export class AppIdentityLinkDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  applicationId: string;
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  identityInstallId: string;
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty()
  issuer: string;
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  clientId: string;
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty({ type: [String] })
  redirectUris: string[];
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: IdentityEnvNamesDto })
  envNames: IdentityEnvNamesDto;
}

export class IdentityInstallDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  identityInstallId: string;
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  applicationId: string;
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  name: string;
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty({ nullable: true, type: String })
  issuer: string | null;
  @ApiProperty({
    description:
      'False for an install that predates the key Flui manages it with: reinstall it to manage it from Flui.',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  managed: boolean;
}
