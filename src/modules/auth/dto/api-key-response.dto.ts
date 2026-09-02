import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import {
  PERMISSION_AREA,
  PERMISSION_DEPTH,
  PERMISSION_GROUP_KEYS,
} from '../constants/api-key-groups';

export class ApiKeyResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  id: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  name: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  revoked: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  createdAt: Date;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  expiresAt: Date | null;

  /**
   * When this key last authenticated a request, to the nearest minute.
   *
   * Null means "not seen since this instance started recording", which is not
   * the same claim as "never used": the column arrived after most rows did.
   * Whoever reads it is deciding which key to revoke, and a trace that says
   * "never" about a key a script uses daily is worse than no trace at all —
   * which is why it is not derived from the MCP audit log, that one only sees
   * the toolbox.
   */
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    type: Date,
    description:
      'Last time this key authenticated a request, recorded at most once a ' +
      'minute. Null means not seen since this column existed, not never used.',
  })
  lastUsedAt: Date | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description:
      "Granted scopes. Null means unscoped — the issuer's full weight.",
  })
  scopes: string[] | null;

  @Sensitivity(Sensitivity.PUBLIC)
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

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description:
      'Scopes no listed group accounts for. Normally empty; non-empty means the ' +
      'key was assembled scope by scope and the groups alone do not describe it.',
  })
  ungroupedScopes: string[] | null;

  /**
   * True on the one row that authenticated this very request.
   *
   * The interface warns that revoking a key signs you out, and until now it
   * warned that on every row — so on most of them it was simply false, and the
   * one row where it is true looked no different. It cannot be worked out from
   * the name: after `/sandbox/resume` a guest holds `sandbox-<ns>` and
   * `sandbox-resume-<ns>` and either may be the live one.
   *
   * False for a session that did not arrive with an API key at all (an
   * interactive OIDC bearer token), which is the honest answer: none of these
   * rows is what is holding that session open.
   */
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'True for the key that authenticated this request. Revoking that one ' +
      'ends the caller’s own session.',
  })
  current: boolean;

  /**
   * Which instructions the thing holding this key says it is working from.
   *
   * `lastUsedAt` says a key spoke; this says what it knew when it did. Both are
   * needed to revoke on purpose rather than on a hunch: an agent still calling
   * daily off a document two releases old is the case the published knowledge
   * base already produced once, and from the outside it looks exactly like a
   * healthy one.
   *
   * Null means the holder has never announced itself — not that it is running
   * something old. An agent that never checked in may be working with no
   * instructions at all, which the screen has to be able to say differently.
   */
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    type: String,
    description:
      'The agent skill version this key’s holder last declared at check-in. ' +
      'Null means it has never checked in, which is not the same as out of date.',
  })
  skillVersion: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description:
      'Application ids this key may act on. Null means every application its ' +
      'holder can already reach.',
  })
  applicationIds: string[] | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description:
      'Project ids this key may act on, alongside `applicationIds` rather ' +
      'than instead of it. Null means no project grant.',
  })
  projectIds: string[] | null;
}

export class CreateApiKeyResultDto extends ApiKeyResponseDto {
  // The one and only moment this plaintext is meant to be shown, so masking
  // it unconditionally would make the mint flow unusable: `{ conditional }`
  // keeps the opaque placeholder but gates it on the mask-mode header.
  @Sensitivity(Sensitivity.CREDENTIAL, { conditional: true })
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
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: PERMISSION_GROUP_KEYS })
  key: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: Object.values(PERMISSION_AREA) })
  area: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: Object.values(PERMISSION_DEPTH) })
  depth: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  label: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'One sentence: what saying yes to this means.' })
  summary: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ isArray: true, type: String })
  scopes: string[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Whether the caller may issue a key for this group. False means at least ' +
      'one of its scopes is above the caller, and asking for it is refused whole.',
  })
  grantable: boolean;

  /**
   * Which scopes put the group out of reach — empty whenever `grantable`.
   *
   * Not an enlargement of what the caller may know: the server already
   * computed this set to answer `grantable`, and threw it away in an `&&`. The
   * precise refusal has always been readable by anyone who *attempts* the
   * mint; it was unreadable only from the screen, because a switch the screen
   * disables never gets attempted. Whoever cannot see why a switch is missing
   * has to go and ask somebody.
   */
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    isArray: true,
    type: String,
    description:
      'The scopes in this group that are above the caller — either absent from ' +
      'their own credential or beyond their permissions. Empty when grantable.',
  })
  blockedScopes: string[];
}
