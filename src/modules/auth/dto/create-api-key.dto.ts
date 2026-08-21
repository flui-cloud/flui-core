import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsISO8601,
  MinLength,
  MaxLength,
  IsArray,
  ArrayUnique,
} from 'class-validator';
import { GRANTABLE_SCOPES } from '../constants/api-key-scopes';
import { PERMISSION_GROUP_KEYS } from '../constants/api-key-groups';

export class CreateApiKeyDto {
  @ApiProperty({ example: 'smoke-test' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name: string;

  @ApiPropertyOptional({
    example: '2027-01-01T00:00:00.000Z',
    description: 'ISO 8601 expiry date. Omit for no expiry.',
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({
    isArray: true,
    enum: PERMISSION_GROUP_KEYS,
    description:
      'Permission groups granted to this key — the unit a person switches on ' +
      'when connecting an agent. Each expands to the scopes it names; a group ' +
      'holding one scope the issuer does not is refused whole, never trimmed. ' +
      'May be combined with `scopes`, in which case the two are unioned and the ' +
      'same ceiling applies to the result.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  groups?: string[];

  @ApiPropertyOptional({
    isArray: true,
    enum: GRANTABLE_SCOPES,
    description:
      'Scopes granted to this key. Omit both this and `groups` for an unscoped ' +
      'key, which carries the full weight of the issuer. Every scope must be ' +
      'one the issuer already holds the permission for, or the request is refused.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  scopes?: string[];
}
