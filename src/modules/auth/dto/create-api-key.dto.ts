import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsISO8601,
  MinLength,
  MaxLength,
  IsArray,
  IsBoolean,
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
      'Scopes granted to this key. Every scope must be one the issuer already ' +
      'holds the permission for, or the request is refused. Combine with ' +
      '`groups` or use either alone; for a key with no ceiling at all, say ' +
      '`unscoped: true` instead — omitting all three is refused.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  scopes?: string[];

  /**
   * Asking for the full weight, out loud.
   *
   * It exists so that omission can stop meaning it. A request naming neither
   * `scopes` nor `groups` used to mint a key carrying everything the issuer
   * could do — the widest credential this product hands out, produced by
   * silence — while the screen that mints the same keys already refused an
   * empty request in so many words. Two surfaces of one product said opposite
   * things about the same request; this is the flag that lets the API say what
   * the screen says.
   *
   * It is not a way to ask for *more*: an unscoped key is still worth exactly
   * what its issuer is worth, no more, and `ApiKeyStrategy` re-reads the
   * owner's identity on every call.
   */
  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Issue a key with no scope ceiling, carrying the full weight of the ' +
      'issuer. Mutually exclusive with `scopes` and `groups`; one of the three ' +
      'is required, because an empty request used to mean this one silently.',
  })
  @IsOptional()
  @IsBoolean()
  unscoped?: boolean;

  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description:
      'Application ids this key may act on. Omit for a key that may act on ' +
      'every application its issuer can already reach — the default, ' +
      'unchanged from before this field existed. Not validated against ' +
      'ownership at issue time: an id the issuer does not own simply opens ' +
      'nothing, the same as naming it by hand would.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  applicationIds?: string[];
}
