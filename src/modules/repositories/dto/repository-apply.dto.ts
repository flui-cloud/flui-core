/**
 * The apply: what the caller asks for, and what Flui reports it did.
 *
 * The request carries no manifests. Everything committed is rendered
 * server-side from the map at the moment of the apply, because the alternative
 * — accepting `flui.yaml` bodies from the client and writing them into
 * somebody's repository — makes this endpoint a way to put arbitrary content
 * and arbitrary workflow triggers into a repository the caller merely
 * connected. The only thing the client chooses is *which* units, and it can
 * only choose from the ones the render produced.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, IsUUID } from 'class-validator';
import { SkippedUnitDto } from './repository-map.dto';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class RepositoryApplyDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'The cluster the applications are created on. Required: an apply that ' +
      'was never weighed against a cluster is not an apply, and the verdict ' +
      'this endpoint refuses on is a function of (repository, cluster).',
  })
  @IsUUID()
  clusterId: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({
    description:
      'The branch to read and to cut from. Defaults to the repository default ' +
      'branch. This branch is never written to.',
  })
  @IsOptional()
  @IsString()
  branch?: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({
    description:
      'Apply only these units (their `render.units[].unitId`). Omitted, every ' +
      'rendered unit is applied. A unit the render skipped can never be named ' +
      'here — there is no manifest for it.',
    type: [String],
    example: ['api', 'web'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  unitIds?: string[];
}

export class AppliedUnitDto {
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ description: 'The unit directory, `.` for the repo root' })
  unitId: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ description: 'metadata.name of the rendered manifest' })
  name: string;

  // `tenant-identity` per `RemovalSnapshotOfferDto.applicationId`; the slug and
  // the name are the author's own words, as they are there.
  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty()
  applicationId: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  slug: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description: 'Where the rendered manifest was committed',
    example: 'api/flui.yaml',
  })
  manifestPath: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description: 'Where this unit’s build workflow was committed',
    example: '.github/workflows/flui-api-3f9a2c.yml',
  })
  workflowPath: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      '`AWAITING_BUILD` when the unit was armed, `PENDING` when it was not.',
    example: 'AWAITING_BUILD',
  })
  status: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Whether this unit was armed after the commit: the webhook credential ' +
      'stored, the build row opened, the status moved to AWAITING_BUILD. Its ' +
      'build is running either way — the commit that starts every build has ' +
      'already landed — but a unit that is not armed answers its own webhook ' +
      'with a 401 and will never deploy on its own.',
  })
  armed: boolean;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({
    description: 'Why the unit was not armed. Absent when it was.',
  })
  reason?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'For a unit that was not armed: whether Flui could mark it so the next apply of this ' +
      'repository reuses it. False means the next apply will not recognise it and will create a ' +
      'second application — with a second database if this one attached any — beside it.',
  })
  markedForReuse?: boolean;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiPropertyOptional({
    description:
      'The GitHub Actions run this unit’s build started, when it could be ' +
      'resolved in the seconds after the commit. Absent is not a failure: the ' +
      'build watcher finds the run either way.',
  })
  workflowRunUrl?: string;

  /**
   * The keys, never the values. Filled from the application this apply just
   * prepared, whose env already carries the `secret: true` entries the render
   * declared as `pending` — so the caller learns in the same answer which
   * variables are still owed, instead of reading each application back one at
   * a time and meeting the guard once per unit.
   */
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description:
      'Variables this unit declared as secret and has no value for yet. The ' +
      'names only — a value is delivered by a person, never through this API. ' +
      'Empty when the unit needs nothing.',
    type: [String],
    example: ['STRIPE_SECRET_KEY'],
  })
  pendingInputs: string[];
}

export class RepositoryApplyResponseDto {
  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty()
  repositoryId: string;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty({ example: 'acme/shop' })
  repoFullName: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description: 'The branch that was read and cut from. Never written to.',
    example: 'main',
  })
  baseBranch: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description:
      'The exact commit the map was read at and the new branch was cut from.',
  })
  baseCommitSha: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description: 'The branch Flui created and committed to.',
    example: 'flui/deploy-3f9a2c1',
  })
  branch: string;

  // These three are `https://github.com/<owner>/<repo>/…`: an address that
  // names the repository. `network-identifier` substitutes them with the
  // `.invalid` host the fake generator keeps for a non-IP address.
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty()
  branchUrl: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ description: 'The single commit that started every build.' })
  commitSha: string;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty()
  commitUrl: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description: 'Every path in that commit, in the order it was written.',
    type: [String],
  })
  files: string[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [AppliedUnitDto] })
  units: AppliedUnitDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'True when at least one unit was committed but not armed. The commit is ' +
      'real and its builds are running, so this is not an error to retry ' +
      'blindly — it is the honest half of an apply that got most of the way. ' +
      'Which units, and why, is in `units[].armed` / `units[].reason`.',
  })
  partial: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    type: [SkippedUnitDto],
    description:
      'Units the render could not turn into a manifest. They are named here ' +
      'rather than dropped: nothing was committed for them and no application ' +
      'exists for them.',
  })
  skipped: SkippedUnitDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'The verdict the apply was allowed to proceed on.',
    example: 'deployable',
  })
  verdict: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ description: 'That verdict, in words.' })
  verdictReason: string;
}
