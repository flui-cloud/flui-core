import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PERMISSION_AREA,
  PERMISSION_DEPTH,
  PERMISSION_GROUP_KEYS,
} from '../constants/api-key-groups';

export class ApiKeyResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  revoked: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiPropertyOptional()
  expiresAt: Date | null;

  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description:
      "Granted scopes. Null means unscoped — the issuer's full weight.",
  })
  scopes: string[] | null;

  @ApiPropertyOptional({
    isArray: true,
    enum: PERMISSION_GROUP_KEYS,
    description:
      'The permission groups this key carries, derived from its scopes and not ' +
      'stored: the deepest group held in each area. Null when the key is ' +
      'unscoped. Empty when the scopes match no group, in which case ' +
      '`ungroupedScopes` says what it does carry.',
  })
  groups: string[] | null;

  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description:
      'Scopes no listed group accounts for. Normally empty; non-empty means the ' +
      'key was assembled scope by scope and the groups alone do not describe it.',
  })
  ungroupedScopes: string[] | null;
}

export class CreateApiKeyResultDto extends ApiKeyResponseDto {
  @ApiProperty({
    description: 'Plaintext API key — shown only once at creation time.',
  })
  key: string;
}

/**
 * One row of the taxonomy, as a panel needs it: a name, one sentence, what it
 * expands to, and whether the person reading it may hand it on.
 */
export class PermissionGroupDto {
  @ApiProperty({ enum: PERMISSION_GROUP_KEYS })
  key: string;

  @ApiProperty({ enum: Object.values(PERMISSION_AREA) })
  area: string;

  @ApiProperty({ enum: Object.values(PERMISSION_DEPTH) })
  depth: string;

  @ApiProperty()
  label: string;

  @ApiProperty({ description: 'One sentence: what saying yes to this means.' })
  summary: string;

  @ApiProperty({ isArray: true, type: String })
  scopes: string[];

  @ApiProperty({
    description:
      'Whether the caller may issue a key for this group. False means at least ' +
      'one of its scopes is above the caller, and asking for it is refused whole.',
  })
  grantable: boolean;
}
