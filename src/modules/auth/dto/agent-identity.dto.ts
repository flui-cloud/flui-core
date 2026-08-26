import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { GRANTABLE_SCOPES } from '../constants/api-key-scopes';
import { PERMISSION_GROUP_KEYS } from '../constants/api-key-groups';

export class CreateAgentIdentityDto {
  @ApiProperty({
    example: 'release-bot',
    description:
      'What this agent is called. It becomes the machine account’s username, ' +
      'prefixed so an operator reading the provider can tell Flui’s agents ' +
      'from anything else living there.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name: string;

  @ApiPropertyOptional({
    isArray: true,
    enum: PERMISSION_GROUP_KEYS,
    description:
      'Permission groups this identity carries — the same unit of consent an ' +
      'API key is minted with. Expanded to scopes and subject to the same ' +
      'ceiling; a group holding one scope the caller does not is refused whole.',
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
      'Scopes this identity carries, named one by one. Combine with `groups` ' +
      'or use either alone. There is no unscoped form: an identity with no ' +
      'ceiling would be an agent nobody can describe.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  scopes?: string[];
}

/**
 * The credential, handed over once.
 *
 * The provider does not store the secret in a readable form either, so this is
 * not a policy that could be relaxed — asking for the same identity again
 * rotates it rather than repeating it.
 */
export class AgentIdentityResultDto {
  @ApiProperty()
  userId: string;

  @ApiProperty({
    description: 'The machine account’s username in the provider.',
  })
  userName: string;

  @ApiProperty()
  clientId: string;

  @ApiProperty({
    description:
      'Shown exactly once. Asking again for the same name rotates it and ' +
      'invalidates this one.',
  })
  clientSecret: string;

  @ApiProperty({ isArray: true, type: String })
  scopes: string[];

  @ApiProperty({
    isArray: true,
    enum: PERMISSION_GROUP_KEYS,
    description:
      'The groups these scopes amount to, derived and not stored — the same ' +
      'reading an API key gets.',
  })
  groups: string[];
}

/** One agent identity, as a list of them needs it. */
export class AgentIdentityDto {
  @ApiProperty()
  userId: string;

  @ApiProperty()
  userName: string;

  @ApiPropertyOptional({ type: String })
  name?: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The account on this instance the identity acts as, which is what its ' +
      'rows in the activity register are keyed by. Null until it has ' +
      'authenticated once: the local account is created on the first token, ' +
      'and minting one earlier would invent an account for something that has ' +
      'never arrived.',
  })
  fluiUserId: string | null;
}
