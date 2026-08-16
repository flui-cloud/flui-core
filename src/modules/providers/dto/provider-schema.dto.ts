import { ApiProperty } from '@nestjs/swagger';
import { CredentialType } from '../../management/entities/credentials.entity';

export class ProviderSchemaFieldDto {
  @ApiProperty({ example: 'apiKey' })
  key: string;

  @ApiProperty({ example: 'API Token' })
  label: string;

  @ApiProperty({
    example: 'Hetzner Cloud Console → Security → API Tokens',
    description: 'Where the user finds this value in the provider console.',
  })
  hint: string;

  @ApiProperty({ description: 'Render as a password field and never echo it.' })
  secret: boolean;

  @ApiProperty()
  required: boolean;
}

export class ProviderSchemaDto {
  @ApiProperty({ example: 'hetzner' })
  provider: string;

  @ApiProperty({ example: 'Hetzner Cloud' })
  displayName: string;

  @ApiProperty({
    enum: CredentialType,
    description:
      'Whether the provider issues a single token or a key pair. Consumers must render exactly what the provider hands out.',
  })
  credentialType: CredentialType;

  @ApiProperty({ type: [ProviderSchemaFieldDto] })
  fields: ProviderSchemaFieldDto[];

  @ApiProperty({
    description: 'Provider documentation for creating the credential.',
  })
  documentationUrl: string;

  @ApiProperty({ description: 'Provider console, for the revoke step.' })
  consoleUrl: string;
}
