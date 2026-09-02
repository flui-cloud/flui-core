import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { SecretRead, SecretVersionMeta } from '../engine/secrets-engine';

export class SecretVersionMetaDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  version: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  createdTime?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  deleted: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  destroyed: boolean;

  constructor(meta: SecretVersionMeta) {
    this.version = meta.version;
    this.createdTime = meta.createdTime;
    this.deleted = meta.deleted;
    this.destroyed = meta.destroyed;
  }
}

/**
 * `SecretRead` wrapped as a real DTO class, same reason as
 * `IdentityUserResponseDto`: a plain interface has no metadata for the
 * sentinel or the interceptor to find, so the KV values shipped unseen.
 */
export class SecretReadResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  path: string;

  @Sensitivity(Sensitivity.CREDENTIAL)
  @ApiProperty({
    description: 'KV pairs of the read version.',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  data: Record<string, string>;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  version: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  createdTime?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [SecretVersionMetaDto] })
  versions: SecretVersionMetaDto[];

  constructor(secret: SecretRead) {
    this.path = secret.path;
    this.data = secret.data;
    this.version = secret.version;
    this.createdTime = secret.createdTime;
    this.versions = secret.versions.map((v) => new SecretVersionMetaDto(v));
  }
}

/** The `{ found, secret }` shape `SecretsConsoleController.read()` returns. */
export class SecretReadResultDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  found: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ type: SecretReadResponseDto, nullable: true })
  secret: SecretReadResponseDto | null;

  constructor(found: boolean, secret: SecretReadResponseDto | null) {
    this.found = found;
    this.secret = secret;
  }
}
