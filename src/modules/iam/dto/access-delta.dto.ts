import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';

/**
 * How much of the truth the `applications` lists hold.
 *
 * Not a boolean, because "what a principal can reach" is a *predicate*, not a
 * list: a grant scoped to everything, to a cluster, to a kind or to what the
 * holder owns keeps matching applications that do not exist yet. A list of
 * today's matches is then a real answer and an incomplete one at the same time,
 * and a surface that renders it as "these three" says something false about the
 * fourth one deployed tomorrow.
 *
 * - `exact` — the access being lost or gained named specific applications (a
 *   selector with `slugs`), or named none at all. The list is the whole truth.
 * - `snapshot` — the list is every application that matches *today*; the scope
 *   is a standing predicate, so it also covers whatever matches later.
 * - `unknown` — the application inventory could not be read. An empty list then
 *   means "not known", never "nothing", and no surface may render it as none.
 */
export type AccessDeltaCoverage = 'exact' | 'snapshot' | 'unknown';

export class AccessDeltaAppDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;

  @ApiProperty({ example: 'production-hz' })
  clusterName: string;
}

export class AccessDeltaSectionDto {
  @ApiProperty({ example: 'clusters' })
  key: string;

  @ApiPropertyOptional({
    enum: ['full', 'read-only'],
    description:
      'The level held before the change; absent when there was none.',
  })
  from?: 'full' | 'read-only';

  @ApiPropertyOptional({
    enum: ['full', 'read-only'],
    description: 'The level held after; absent when the section closes.',
  })
  to?: 'full' | 'read-only';
}

export class AccessDeltaPrincipalDto {
  @ApiProperty({ enum: ['user', 'group', 'service_account'] })
  type: string;

  @ApiProperty({ example: 'alice@acme.com' })
  ref: string;
}

/**
 * What an access change takes away, and what it hands over — before it happens,
 * or alongside the write that made it happen.
 *
 * The one field to read before believing any empty list is `coverage`. The rest
 * is ordered the way a person reads it: the sentence, then the sections that
 * close (a closed set, always exact), then the applications, then the raw
 * permissions.
 */
export class AccessDeltaDto {
  @ApiProperty({ type: AccessDeltaPrincipalDto })
  principal: AccessDeltaPrincipalDto;

  @ApiProperty({
    example:
      'alice@acme.com loses 3 applications and the Clusters section — and anything matching later.',
    description:
      'The one sentence every surface shows. Always present, and it is the ' +
      'only field that is safe to render on its own.',
  })
  summary: string;

  @ApiProperty({
    description:
      'True when the change only adds. A surface may skip the warning ' +
      'entirely on this, and on nothing else.',
  })
  losesNothing: boolean;

  @ApiProperty({
    description:
      'True when the principal is left with no access at all: every section ' +
      'closed, no permission anywhere.',
  })
  losesEverything: boolean;

  @ApiProperty({
    description:
      'True when the principal is a platform admin, whose reach comes from ' +
      'the boolean and not from these bindings — so this change moves nothing.',
  })
  principalIsPlatformAdmin: boolean;

  @ApiProperty({
    type: [AccessDeltaSectionDto],
    description: 'Sections that close entirely. Exact: a closed set of twelve.',
  })
  sectionsClosed: AccessDeltaSectionDto[];

  @ApiProperty({
    type: [AccessDeltaSectionDto],
    description: 'Sections that drop from full to read-only.',
  })
  sectionsDowngraded: AccessDeltaSectionDto[];

  @ApiProperty({ type: [AccessDeltaSectionDto] })
  sectionsOpened: AccessDeltaSectionDto[];

  @ApiProperty({
    enum: ['exact', 'snapshot', 'unknown'],
    description:
      'How much of the truth the application lists hold. `snapshot` means ' +
      'they also cover what matches later; `unknown` means an empty list is ' +
      'not an empty answer.',
  })
  coverage: AccessDeltaCoverage;

  @ApiProperty({
    type: [AccessDeltaAppDto],
    description:
      'Applications the principal will no longer be able to read, named up ' +
      'to a cap. Compare against `applicationsLostCount` for the exact total.',
  })
  applicationsLost: AccessDeltaAppDto[];

  @ApiProperty({
    description:
      'Exact number lost — never capped, so a truncated list is still ' +
      'countable. Meaningless when `coverage` is `unknown`.',
  })
  applicationsLostCount: number;

  @ApiProperty({ type: [AccessDeltaAppDto] })
  applicationsGained: AccessDeltaAppDto[];

  @ApiProperty()
  applicationsGainedCount: number;

  @ApiProperty({
    type: [String],
    description: 'Permissions the principal stops holding anywhere.',
  })
  permissionsLost: string[];

  @ApiProperty({ type: [String] })
  permissionsGained: string[];

  @ApiPropertyOptional({
    description:
      'Why the applications could not be listed, when they could not.',
  })
  note?: string;
}

/** One hypothetical binding, in the same shape `POST /iam/grants` takes. */
export class AccessPreviewBindingDto {
  @ApiProperty({ example: 'operator' })
  @IsString()
  role: string;

  @ApiProperty({ enum: ['global', 'section', 'cluster', 'selector'] })
  @IsIn(['global', 'section', 'cluster', 'selector'])
  scopeType: 'global' | 'section' | 'cluster' | 'selector';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  scopeRef?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  selector?: Record<string, unknown>;
}

/**
 * "Resolve this principal as if these bindings were added and those removed."
 *
 * One shape for all three verbs the requirement names: conferring is `add`,
 * revoking is `removeGrantIds`, and changing a role is both at once — which is
 * exactly how the screens do it, and why they must be able to ask about it as
 * one question rather than two.
 */
export class AccessPreviewDto {
  @ApiProperty({ enum: ['user', 'group', 'service_account'] })
  @IsIn(['user', 'group', 'service_account'])
  principalType: 'user' | 'group' | 'service_account';

  @ApiProperty({ example: 'alice@acme.com' })
  @IsString()
  principalRef: string;

  @ApiPropertyOptional({ type: [AccessPreviewBindingDto] })
  @IsOptional()
  @IsArray()
  add?: AccessPreviewBindingDto[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  removeGrantIds?: string[];
}
