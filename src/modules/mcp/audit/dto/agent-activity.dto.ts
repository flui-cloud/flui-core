import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ACTOR_KIND_UNKNOWN } from '../agent-activity.query';
import { UNDER_ABSENT, UnderAbsent } from '../agent-activity.answer';
import {
  OUTCOME_DEPARTED,
  REGISTER_SURFACE,
  REGISTER_SURFACE_UNKNOWN,
} from '../register-surface';

export const ACTOR_KINDS = ['user', 'key', 'agent', ACTOR_KIND_UNKNOWN];

export const REGISTER_SURFACES = [
  ...Object.values(REGISTER_SURFACE),
  REGISTER_SURFACE_UNKNOWN,
];

const ISO_BOUND = 'ISO 8601, inclusive';

export class AgentActivityQueryDto {
  @ApiPropertyOptional({
    enum: ACTOR_KINDS,
    description:
      '`unknown` selects the rows written before the actor was recorded. They ' +
      'are not "a person did it" and must not be rendered as one.',
  })
  @IsOptional()
  @IsIn(ACTOR_KINDS)
  actorKind?: string;

  @ApiPropertyOptional({
    enum: REGISTER_SURFACES,
    description:
      'Which door the call came through: the MCP server, the in-product ' +
      'assistant, or `api` — the credential presented straight at a route, ' +
      'with no surface in front of it. `unknown` selects the rows written ' +
      'before the register recorded this, which is not the same set as `api`.',
  })
  @IsOptional()
  @IsIn(REGISTER_SURFACES)
  surface?: string;

  @ApiPropertyOptional({
    description: 'The api_keys row that authenticated it',
  })
  @IsOptional()
  @IsUUID()
  keyId?: string;

  @ApiPropertyOptional({
    description:
      'Whose calls. Honoured only for a caller who reads the whole instance; ' +
      "anybody else asking for somebody else's rows gets an empty page, which " +
      'is the same answer as "there are none".',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  userId?: string;

  @ApiPropertyOptional({ description: 'Tool name, exactly' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  tool?: string;

  @ApiPropertyOptional({
    description:
      '`input_required` — a turn that stopped to ask a person. `' +
      OUTCOME_DEPARTED +
      '` — a call the door let through, written before the handler ran: it ' +
      'says the pause was removed, not that the call succeeded.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  outcome?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description: '`false` selects refusals: no scope, no permission, disabled.',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  allowed?: string;

  @ApiPropertyOptional({ description: 'Calls that started this operation' })
  @IsOptional()
  @IsUUID()
  operationId?: string;

  @ApiPropertyOptional({
    description:
      'What a request is, both halves: the call that raised it, and every call ' +
      'that departed under its answer — the one-off itself, and anything the ' +
      'standing permission it produced let through afterwards. It narrows within your ' +
      'own rows like every other filter, so it discloses nothing a plain page ' +
      'would not; a request that authorised nothing answers empty.',
  })
  @IsOptional()
  @IsUUID()
  proposalId?: string;

  @ApiPropertyOptional({ description: ISO_BOUND })
  @IsOptional()
  @IsISO8601()
  since?: string;

  @ApiPropertyOptional({ description: ISO_BOUND })
  @IsOptional()
  @IsISO8601()
  until?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/**
 * What an operation contributes to a register row.
 *
 * A fixed projection, and the fixing is the point. `metadata` on an operation
 * carries whatever the caller of the day put there — `serverConfig`,
 * `clusterConfig`, a whole install's inputs — and none of it went through the
 * argument redactor. Returning the row would hand back through the join exactly
 * what the redaction withholds in the column beside it. The same fields the
 * revoke dialog already projects, and nothing else.
 */
export class AgentActivityOperationDto {
  @ApiProperty() id: string;
  @ApiProperty({ nullable: true }) operationType: string | null;
  @ApiProperty() status: string;
  @ApiProperty() progress: number;
  @ApiProperty({ nullable: true }) resourceType: string | null;
  @ApiProperty({ nullable: true }) resourceName: string | null;
  @ApiProperty({ nullable: true }) resourceId: string | null;
  @ApiProperty({ nullable: true }) currentStep: string | null;
  @ApiProperty({ nullable: true }) startedAt: Date | null;
  @ApiProperty({ nullable: true }) completedAt: Date | null;
  @ApiProperty({
    nullable: true,
    description: 'When somebody asked this to stop.',
  })
  cancelRequestedAt: Date | null;

  @ApiProperty({
    nullable: true,
    description:
      'Under which answer this was allowed to start. It holds a concession id ' +
      'when a standing permission removed the pause, and a proposal id when a ' +
      'one-off "allow once" was spent — the guard writes whichever applied. ' +
      'The column alone cannot say which; `under` on the entry does, and ' +
      '`proposalId` there names the request either way.',
  })
  grantId: string | null;
}

export class AgentActivityEntryDto {
  @ApiProperty() id: string;
  @ApiProperty() at: Date;
  @ApiProperty({ description: 'Whom the call was made for' }) userId: string;
  @ApiProperty({
    description:
      'What was called. A tool name on the two agentic surfaces; on `api` the ' +
      'declared route shape — `POST /applications/:id/deploy` — which is the ' +
      'same string a standing permission is stored under.',
  })
  tool: string;

  @ApiProperty({
    description:
      'The MCP scope the tool was gated on. On the `api` surface there is no ' +
      'tool and no scope, so this holds the IAM permission the route declares ' +
      '— read off the same metadata the permission gate enforced — or ' +
      '`unstated` when the route declares none. The two vocabularies are ' +
      'apart on sight: every MCP scope begins `mcp:`, no IAM permission does.',
  })
  scope: string;

  @ApiProperty({
    nullable: true,
    enum: Object.values(REGISTER_SURFACE),
    description:
      'Which door this call came through. `api` means the credential was ' +
      'presented straight at a route — `curl`, a script, anything holding the ' +
      'key — with no agentic surface in front of it. null on rows written ' +
      'before the register recorded this, which is not a claim that it was ' +
      '`api`. The table is still called `mcp_tool_call_logs` and is no longer ' +
      "only MCP's; renaming it would have dropped it.",
  })
  surface: string | null;

  @ApiProperty({ description: 'false when the call was refused' })
  allowed: boolean;

  @ApiProperty({
    nullable: true,
    description:
      '`input_required` when the turn stopped to ask a person. `' +
      OUTCOME_DEPARTED +
      '` on a call the door recorded on its way past — a guard runs before ' +
      'the handler and before the route-level guards after it, so what that ' +
      'row claims is that the pause was removed, never that the call ' +
      'succeeded. Read it beside `allowed`, which on those rows is the ' +
      "cycle's verdict and not the response's.",
  })
  outcome: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Why the call did not do what it was asked to. Handed back as stored ' +
      'only to a reader entitled to the full diagnosis — whoever administers ' +
      'access, from a credential that declares no agent ceiling. To anybody ' +
      'else this is a sentence saying which kind of failure it was and that ' +
      'the text is withheld, because an error message in this product is ' +
      'built by concatenation and can carry whatever the failing component ' +
      'put in it. `errorWithheld` says which of the two you are reading.',
  })
  error: string | null;

  @ApiProperty({
    description:
      'true when `error` is this register speaking rather than the stored ' +
      'text. Never means "no error": `error: null` means that.',
  })
  errorWithheld: boolean;

  @ApiProperty({
    nullable: true,
    enum: ACTOR_KINDS,
    description: 'null on rows written before the actor was recorded',
  })
  actorKind: string | null;

  @ApiProperty({ nullable: true }) actorKeyId: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'The name the key was minted under. null when no key authenticated the ' +
      'call, or when the key has since been deleted — the register outlives ' +
      'the credential on purpose.',
  })
  actorKeyName: string | null;

  @ApiProperty({ nullable: true }) actorKeyRevoked: boolean | null;

  @ApiProperty({
    nullable: true,
    description:
      'The call arguments as they were stored: closed-set values verbatim, ' +
      'everything else `****`. Redacted on the way in, never on the way out — ' +
      'there is no unredacted copy to widen this to.',
  })
  args: Record<string, unknown> | null;

  @ApiProperty({ nullable: true }) operationId: string | null;

  @ApiProperty({
    type: AgentActivityOperationDto,
    nullable: true,
    description:
      'null when the call started nothing, and also when the caller may not ' +
      'read that operation — the id stays, the detail does not.',
  })
  operation: AgentActivityOperationDto | null;

  @ApiProperty({
    nullable: true,
    enum: ['concession', 'approval'],
    description:
      'Which answer let this through: a standing permission, or a one-off ' +
      '"allow once". Taken from the row itself when the door that wrote it ' +
      "knew the verdict first-hand, and otherwise from the operation's " +
      '`grantId` — so it is null for a tool call that started no operation, ' +
      'which is where the cycle stamps its verdict for that surface. A refusal ' +
      'is not a third value here: `allowed: false` already says it, and ' +
      '`outcome: input_required` says the turn stopped to ask. When this is ' +
      'null, `underAbsent` says which of five reasons it is.',
  })
  under: 'concession' | 'approval' | null;

  @ApiProperty({
    nullable: true,
    description:
      'The sentence the person read at the moment of the yes, stored verbatim ' +
      'rather than re-rendered. Only for a standing permission, and only to ' +
      'whoever gave it or reads the whole instance.',
  })
  underSentence: string | null;

  @ApiProperty({
    nullable: true,
    enum: Object.values(UNDER_ABSENT),
    description:
      'Why `under` is empty, so an empty column is a fact about the call ' +
      'rather than a gap in the register. `refused` nothing was allowed · ' +
      '`waiting` the turn stopped to ask, and the answer belongs to the ' +
      'retry · `no-operation` the call started nothing, and the answer is ' +
      'stamped on an operation · `operation-withheld` it started one you may ' +
      'not read · `not-paused` the route never pauses for a person, so there ' +
      'was no answer to record. Null exactly when `under` is set.',
  })
  underAbsent: UnderAbsent | null;

  @ApiProperty({
    nullable: true,
    description: 'The same reason in words, ready to show in place of a blank.',
  })
  underAbsentReason: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'The request this call departed under — `/agent/proposals/:id`. Derived, ' +
      'never a foreign key: a one-off answer stamps the proposal itself as the ' +
      "grant, and a standing one is reached through the concession's " +
      '`fromProposalId`. Null for a call no request stands behind, and also on ' +
      'the row that *raised* a request — nothing had been answered yet when it ' +
      'was written, and that row names its request in `raisedProposalId`.',
  })
  proposalId: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'The request this call *raised* — the turn that stopped to ask, which ' +
      'departed under nothing and so names no permission. The mirror of ' +
      '`proposalId`: that one says what a call went out under, this one says ' +
      'what it asked for. It has a column of its own because the two tables ' +
      'share no key and correlating them on user, credential and instant ' +
      'would be a guess; not a foreign key, so the record of what was asked ' +
      'survives the request being answered and cleaned up.',
  })
  raisedProposalId: string | null;
}

export class AgentActivityPageDto {
  @ApiProperty({
    enum: ['own', 'instance'],
    description:
      'What this page is a page of. Stated rather than implied: a screen that ' +
      'cannot tell a filtered view from a complete one shows an empty register ' +
      'as "nothing happened".',
  })
  scope: 'own' | 'instance';

  @ApiProperty() total: number;
  @ApiProperty() limit: number;
  @ApiProperty() offset: number;
  @ApiProperty({ type: [AgentActivityEntryDto] })
  entries: AgentActivityEntryDto[];
}

export class AgentIdentityActivityDto {
  @ApiProperty({ nullable: true, enum: ACTOR_KINDS })
  actorKind: string | null;

  @ApiProperty({ nullable: true }) actorKeyId: string | null;
  @ApiProperty({ nullable: true }) actorKeyName: string | null;
  @ApiProperty({ nullable: true }) actorKeyRevoked: boolean | null;

  @ApiProperty({
    nullable: true,
    description:
      'When the key last authenticated anything, which is not the same claim ' +
      'as the activity below: a credential can authenticate and call nothing.',
  })
  keyLastUsedAt: Date | null;

  @ApiProperty({ description: 'Whom this credential acted for' })
  userId: string;

  @ApiProperty() lastActivityAt: Date;
  @ApiProperty({ nullable: true }) lastTool: string | null;
  @ApiProperty({ nullable: true }) lastOutcome: string | null;
  @ApiProperty({ nullable: true }) lastAllowed: boolean | null;
  @ApiProperty() calls: number;
  @ApiProperty({ description: 'How many of those were refused' })
  refused: number;
}

export class AgentIdentityActivityPageDto {
  @ApiProperty({ enum: ['own', 'instance'] }) scope: 'own' | 'instance';
  @ApiProperty({ type: [AgentIdentityActivityDto] })
  identities: AgentIdentityActivityDto[];
}

export class AgentIdentityActivityQueryDto {
  @ApiPropertyOptional({ enum: ACTOR_KINDS })
  @IsOptional()
  @IsIn(ACTOR_KINDS)
  actorKind?: string;

  @ApiPropertyOptional({ description: 'Instance-reach callers only' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  userId?: string;

  @ApiPropertyOptional({ description: ISO_BOUND })
  @IsOptional()
  @IsISO8601()
  since?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
