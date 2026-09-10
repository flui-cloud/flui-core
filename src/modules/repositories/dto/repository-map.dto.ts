/**
 * The map, on the wire.
 *
 * This file is the contract with the dashboard, and its one rule is that it
 * flattens nothing. Every fact cartographer produces carries three things a
 * list of green ticks throws away — where it was read (`evidence`, file and
 * line), how firmly it is held (`confidence`: declared / derived /
 * circumstantial), and whether anybody has settled it (`questions`,
 * `caveats`, `blockers`). A field this DTO does not carry is a field the
 * interface can never show, so each class below `implements` the package's own
 * interface: the compiler, not a reviewer, is what keeps the two in step when
 * cartographer grows a field.
 *
 * The other half of the contract is what was *not* looked at. `boundary` and
 * `read` carry the ceilings, the truncation and the refused symlinks, because
 * "we did not find a database" and "we stopped reading before we could have
 * found one" are different answers and only one of them is safe to act on.
 *
 * On the `@Sensitivity` classification: almost everything here is content read
 * out of somebody else's repository — paths, excerpts of their code, their env
 * key names, prose quoting both — so it is `arbitrary-text`: free text with no
 * field boundary to substitute inside, which is what that level says and why
 * mask mode makes no promise about it. `public` is kept for the platform's own
 * closed vocabularies (enums, reason codes, catalog refs) and for numbers. Only
 * the two names that identify the tenant — `repoFullName` and the repository
 * row — are substituted.
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import type {
  Blocker,
  BlockerCode,
  BuildStrategy,
  CandidateService,
  CapacityAssessment,
  Caveat,
  CaveatCode,
  Cited,
  Confidence,
  Decision,
  DecisionLevel,
  DependencyScope,
  DependencySignal,
  EnvVarRole,
  Evidence,
  ExternalDependency,
  FactProvenance,
  MapCoverage,
  MapUnit,
  OpenQuestion,
  RenderNote,
  RenderedApplicationManifest,
  RequiredInput,
  SearchBoundary,
  ServiceFamily,
  SignalKind,
  SkippedUnit,
  UnitBuild,
  UnitEnvVar,
  UnitFact,
  UnitReadiness,
  UnitReason,
  UnitScope,
  UnitVerdict,
  Verdict,
} from '@flui-cloud/cartographer';

export class EvidenceDto implements Evidence {
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description:
      'Repository-relative path, exactly as it appears in the archive that was read',
    example: 'src/server.js',
  })
  file: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      '1-based line. Absent when the evidence is the existence of the file, not a line inside it',
    example: 8,
  })
  line?: number;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({
    description:
      'The token actually read, verbatim and short — a reader must be able to grep the file for it',
    example: 'EXPOSE 8080',
  })
  excerpt?: string;
}

const PROVENANCE_DESCRIPTION =
  'Whose reading proved this fact. `own` — a file inside the unit itself. ' +
  '`inherited` — a repository-wide file that sits above it, so a sibling unit ' +
  'may hold the same fact for the same reason. `declared` — another unit named ' +
  'this one, which outranks position.';

export class UnitFactNumberDto implements UnitFact<number> {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: 8080 })
  value: number;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description: 'The citation as a sentence, e.g. `Dockerfile:EXPOSE`',
  })
  source: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: PROVENANCE_DESCRIPTION,
    enum: ['own', 'inherited', 'declared'],
  })
  provenance: FactProvenance;
}

export class UnitFactStringDto implements UnitFact<string> {
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ example: '/api/v1/healthz' })
  value: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ description: 'The citation as a sentence' })
  source: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: PROVENANCE_DESCRIPTION,
    enum: ['own', 'inherited', 'declared'],
  })
  provenance: FactProvenance;
}

export class CitedStringDto implements Cited<string> {
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  value: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  source: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'declared | derived | circumstantial',
    enum: ['declared', 'derived', 'circumstantial'],
  })
  confidence: Confidence;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [EvidenceDto] })
  evidence: Evidence[];
}

export class UnitBuildDto implements UnitBuild {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'dockerfile when the unit has one of its own; railpack when it falls to the platform build path',
    enum: ['dockerfile', 'railpack', 'template'],
  })
  strategy: BuildStrategy;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    type: CitedStringDto,
    nullable: true,
    description: 'Present only when strategy is dockerfile',
  })
  dockerfile: Cited<string> | null;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    nullable: true,
    description:
      'Repository-relative build context; null for the repository root',
  })
  context: string | null;
}

export class UnitEnvVarDto implements UnitEnvVar {
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  name: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'literal | secret | derived (the platform supplies it from an attached service) | build-time',
    enum: ['literal', 'secret', 'derived', 'build-time'],
  })
  role: EnvVarRole;

  // Not `credential`: that level substitutes with the header off as well, and
  // this is the value the map exists to show. The engine only ever puts a
  // declared literal here — a `secret` role carries no value at all.
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({
    description:
      'Only on a literal the repository actually wrote down (an example file). Never a value read from a secret',
  })
  value?: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({
    description: 'Only for derived: the service that answers this key',
  })
  fromService?: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  source: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: PROVENANCE_DESCRIPTION,
    enum: ['own', 'inherited', 'declared'],
  })
  provenance: FactProvenance;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [EvidenceDto] })
  evidence: Evidence[];
}

export class MapUnitDto implements MapUnit {
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description: 'The unit directory, `.` for the repository root',
    example: '.',
  })
  id: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  name: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  root: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'Why this directory is a unit',
    enum: [
      'own-dockerfile',
      'compose-build',
      'repository-root',
      'project-file',
    ],
  })
  reason: UnitReason;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: UnitBuildDto })
  build: UnitBuild;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    type: UnitFactNumberDto,
    nullable: true,
    description:
      'The port read from the repository, with its citation. null when nothing stated one — never a convention',
  })
  port: UnitFact<number> | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    type: UnitFactStringDto,
    nullable: true,
    description:
      'The health path read from the repository. null when the engine refused to promote a route it could not recognise',
  })
  healthPath: UnitFact<string> | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [UnitEnvVarDto] })
  env: UnitEnvVar[];

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    nullable: true,
    description:
      'The dependency manifest that governs this unit — package.json, go.mod, pom.xml. Not a flui.yaml: a unit that already declares one is reported through the rendered manifest, not here',
  })
  manifest: string | null;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({ type: [String] })
  manifests?: string[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['declared', 'derived', 'circumstantial'] })
  confidence: Confidence;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [EvidenceDto] })
  evidence: Evidence[];
}

export class DependencySignalDto implements DependencySignal {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'What kind of reading produced this signal' })
  kind: SignalKind;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ description: 'The token read, verbatim' })
  observed: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true })
  engine: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true })
  family: ServiceFamily | null;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    nullable: true,
    description: 'The unit this belongs to; null means "this repository"',
  })
  unit: UnitScope;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ type: [String] })
  injectionKeys: string[];

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ nullable: true })
  localName: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['declared', 'derived', 'circumstantial'] })
  confidence: Confidence;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  source: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [EvidenceDto] })
  evidence: Evidence[];

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional()
  variantNote?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  dependencyScope?: DependencyScope;
}

export class CandidateServiceDto implements CandidateService {
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ description: "The author's own handle where there is one" })
  name: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    description:
      'The catalog ref to install. null when nothing in the registry answers this dependency — which is a blocker or an external, never a silent omission',
  })
  block: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true })
  engine: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true })
  family: ServiceFamily | null;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ nullable: true })
  unit: UnitScope;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: ['declared', 'derived', 'circumstantial'],
    description:
      'The strongest signal in the group. Corroboration never promotes: three circumstantial signals are still circumstantial',
  })
  confidence: Confidence;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [DependencySignalDto] })
  signals: DependencySignal[];

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ type: [String] })
  injectionKeys: string[];

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({
    description:
      'Set when this candidate and others are mutually exclusive alternatives the repository does not settle',
  })
  alternativesGroup?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  preferred?: true;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ type: [String] })
  alternativeRefs?: string[];

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional()
  variantWarning?: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  source: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [EvidenceDto] })
  evidence: Evidence[];
}

export class RequiredInputDto implements RequiredInput {
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  name: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ nullable: true })
  forService: string | null;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ nullable: true })
  unit: UnitScope;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  secret: boolean;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  reason: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  source: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [EvidenceDto] })
  evidence: Evidence[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      "Set when the built image's own fixed startup command names this value as a condition of running at all",
  })
  blocksStart?: true;
}

export class ExternalDependencyDto implements ExternalDependency {
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ description: 'The service as the repository names it' })
  name: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    type: [String],
    description:
      'The env keys that carry the credential, when the repository names them',
  })
  requires: string[];

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ nullable: true })
  unit: UnitScope;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['declared', 'derived', 'circumstantial'] })
  confidence: Confidence;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  source: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [EvidenceDto] })
  evidence: Evidence[];
}

export class BlockerDto implements Blocker {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'docker-socket | privileged | host-network | accelerator | bind-mount-config | build-secret | no-catalog-equivalent | kernel-requirement | unreadable',
  })
  code: BlockerCode;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ nullable: true })
  unit: UnitScope;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description: 'What is wrong, in one sentence, naming the thing',
  })
  summary: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description:
      'What would remove it. A blocker with no remedy is a dead end presented as one',
  })
  remedy: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  source: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [EvidenceDto] })
  evidence: Evidence[];
}

export class CaveatDto implements Caveat {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'It runs, degraded: embedded-database, ambiguous-alternatives, truncated-scan, interchange-default, cross-unit-evidence, …',
  })
  code: CaveatCode;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ nullable: true })
  unit: UnitScope;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  summary: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  source: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [EvidenceDto] })
  evidence: Evidence[];
}

export class OpenQuestionDto implements OpenQuestion {
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ description: 'Stable across runs of the same repository' })
  id: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  question: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    type: [String],
    description:
      'The readings the evidence actually supports. An empty list is a free answer, not a missing one',
  })
  options: string[];

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  source: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [EvidenceDto] })
  evidence: Evidence[];
}

export class DecisionDto implements Decision {
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description: 'What the decision is about: "service `redis`: catalog block"',
  })
  subject: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ description: 'The value chosen' })
  choice: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['L0', 'L1', 'L2', 'L3'] })
  decidedBy: DecisionLevel;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['declared', 'derived', 'circumstantial'] })
  confidence: Confidence;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ description: 'One sentence: why this and not an alternative' })
  reason: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  source: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [EvidenceDto] })
  evidence: Evidence[];

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({
    type: [String],
    description:
      'The other values that were in the running. Absent — never empty — when nothing else was',
  })
  alternatives?: string[];
}

export class SearchBoundaryDto implements SearchBoundary {
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    type: [String],
    description: 'Paths and patterns consulted, exactly as consulted',
  })
  searched: string[];

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    type: [String],
    description:
      'What was looked for and not found. Empty means everything looked for was found — never "nothing was looked for"',
  })
  notFound: string[];
}

export class RepositoryMapDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [MapUnitDto] })
  units: MapUnitDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [CandidateServiceDto] })
  services: CandidateServiceDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [RequiredInputDto] })
  inputs: RequiredInputDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [ExternalDependencyDto] })
  externals: ExternalDependencyDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [BlockerDto] })
  blockers: BlockerDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [CaveatDto] })
  caveats: CaveatDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [OpenQuestionDto] })
  questions: OpenQuestionDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [DecisionDto] })
  decisions: DecisionDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: ['supported', 'best_effort'],
    description:
      'supported is earned by measurement, never declared from structure alone — every map is best_effort until a measured table says otherwise',
  })
  coverage: MapCoverage;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: SearchBoundaryDto })
  boundary: SearchBoundaryDto;
}

export class CapacityAssessmentDto implements CapacityAssessment {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'false when no cluster was named, or when the cluster could not be read, or when nothing in this map declares a footprint to weigh',
  })
  known: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  fits?: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  requiredCpuMillicores?: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  requiredMemoryMebibytes?: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  availableCpuMillicores?: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  availableMemoryMebibytes?: number;
}

export class CapacityComponentDto {
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description: 'What the numbers are about: "unit `.`", "service `postgres`"',
  })
  label: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ nullable: true })
  unit: UnitScope;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  cpuRequestMillicores: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  memoryLimitMebibytes: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  replicas: number;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description:
      'Where these numbers come from — a catalog block that declares them, or the platform default a unit with no declared resources is deployed with',
  })
  basis: string;
}

export class ClusterCapacityDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Whether the capacity half of the verdict was computed at all. When false the verdict speaks only about the repository, and says so',
  })
  assessed: boolean;

  // `public` follows the precedent a cluster id already has:
  // `DbConnectionInfoResponseDto.clusterId` and `RebuildClusterDto.to`.
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    description: 'The cluster the request named, if any',
  })
  clusterId: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    description:
      'Why the capacity half was not computed: no-cluster-in-request, cluster-unreadable, or no-declared-footprint',
  })
  notAssessedReason: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: CapacityAssessmentDto })
  assessment: CapacityAssessmentDto;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    type: [CapacityComponentDto],
    description:
      'Every component whose footprint was weighed, with where its numbers come from',
  })
  components: CapacityComponentDto[];

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    type: [String],
    description:
      'Components that would run and whose footprint could not be weighed. A fit computed without these is a fit that may not hold, and this is where that is said',
  })
  uncounted: string[];
}

export class UnitVerdictDto implements UnitVerdict {
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  id: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: [
      'blocked',
      'not_assessed',
      'deployable_pending_inputs',
      'deployable',
    ],
  })
  readiness: UnitReadiness;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  reason: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    nullable: true,
    description: 'null only when this unit is deployable — nothing left to fix',
  })
  remedy: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [EvidenceDto] })
  evidence: Evidence[];
}

export class VerdictDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: [
      'deployable',
      'deployable_pending_inputs',
      'partial',
      'blocked',
      'insufficient_capacity',
      'not_assessed',
    ],
    description:
      'The closed taxonomy. Every finished analysis lands on exactly one',
  })
  outcome: Verdict;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  reason: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    nullable: true,
    description: 'null only when the outcome is deployable',
  })
  remedy: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [EvidenceDto] })
  evidence: Evidence[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [UnitVerdictDto] })
  units: UnitVerdictDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    type: ClusterCapacityDto,
    description:
      'The cluster half of the verdict — computed, or declared not computed and why. A deployable that was never weighed against a cluster says so here',
  })
  capacity: ClusterCapacityDto;
}

export class RenderedUnitDto {
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  unitId: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description: 'metadata.name — deterministic from the unit’s own facts',
  })
  name: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    type: Object,
    description: 'The kind: Application manifest, parsed',
  })
  manifest: RenderedApplicationManifest;

  // A whole manifest, and whatever the repository declares in it. There is no
  // field boundary inside a text blob to substitute against, the same reason
  // `InstanceDto.metadata` is `arbitrary-text` rather than a false `public`.
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ description: 'The same manifest as flui.yaml text' })
  yaml: string;
}

export class SkippedUnitDto implements SkippedUnit {
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  unitId: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description:
      'Why no manifest could be rendered — never a manifest with an invented field',
  })
  reason: string;
}

export class RenderNoteDto implements RenderNote {
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  unitId: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description:
      'Something the map determined that no rendered manifest could carry faithfully',
  })
  message: string;
}

export class RenderDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [RenderedUnitDto] })
  units: RenderedUnitDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [SkippedUnitDto] })
  skipped: SkippedUnitDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [RenderNoteDto] })
  notes: RenderNoteDto[];
}

export class ReadLimitsDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Archive ceiling, bytes' })
  maxArchiveBytes: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Retained decompressed content ceiling, bytes' })
  maxContentBytes: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Per-file ceiling, bytes' })
  maxFileBytes: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Path-listing ceiling. Passing it is what makes an absence unprovable',
  })
  maxEntries: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Wall clock for the whole read, milliseconds' })
  timeoutMs: number;
}

export class ReadSkippedDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Entries refused because they are symlinks' })
  symlinks: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Entries past the per-file ceiling' })
  oversize: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Entries skipped for any other reason' })
  other: number;
}

export class ReadBoundaryDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Whether the repository was read at all. false is an answer, not an error: everything else below still says what is known',
  })
  ok: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'Why it could not be read: no-credential, not-found, too-large, unreadable, rejected',
  })
  reason?: string;

  // `owner` is a GitHub org or user handle: the same thing `tenant-identity`
  // already covers for an email or an org name.
  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty({ description: 'owner/repo' })
  repoFullName: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ description: 'The git ref asked for' })
  ref: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({
    description:
      'The commit every fact in this response is true of, and of no other tree',
  })
  commitSha?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'true when the walk stopped at a ceiling: an absence below it may be an absence of looking',
  })
  truncated?: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'false when the content ceiling cut file bodies the readers would have parsed',
  })
  contentComplete?: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ type: ReadSkippedDto })
  skipped?: ReadSkippedDto;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ description: 'Decompressed content retained, bytes' })
  bytesRead?: number;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({
    type: [String],
    description: 'High-density paths the content ceiling left unread',
  })
  highDensityUnread?: string[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    type: ReadLimitsDto,
    description: 'The ceilings this read ran under',
  })
  limits: ReadLimitsDto;
}

export class RepositoryMapResponseDto {
  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty({ description: 'The repository this map is of' })
  repositoryId: string;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty({ description: 'owner/repo' })
  repoFullName: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ description: 'The git ref read' })
  branch: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    type: ReadBoundaryDto,
    description:
      'What was read and what was not: the commit, the ceilings, the truncation, the refused symlinks',
  })
  read: ReadBoundaryDto;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    type: RepositoryMapDto,
    nullable: true,
    description:
      'The map. null only when the repository could not be read at all',
  })
  map: RepositoryMapDto | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: VerdictDto })
  verdict: VerdictDto;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    type: RenderDto,
    nullable: true,
    description:
      'One rendered flui.yaml per deployable unit, plus the units that could not be rendered and why',
  })
  render: RenderDto | null;
}
