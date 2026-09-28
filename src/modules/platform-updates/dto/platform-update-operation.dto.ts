import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class PlatformUpdateComponentProgressDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  key: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  name: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true })
  fromVersion: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  targetVersion: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['pending', 'running', 'done', 'skipped', 'failed'] })
  status: string;
}

export class PlatformUpdateOperationDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  id: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: 'IN_PROGRESS' })
  status: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  fromVersion: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  targetVersion: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [PlatformUpdateComponentProgressDto] })
  components: PlatformUpdateComponentProgressDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Database migrations this release applies.' })
  migrations: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ minimum: 0, maximum: 100 })
  progress: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true, description: 'Current step key.' })
  currentStep: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'True while the API is being replaced: the answer to this request comes from the pod on its way out, or from the one that replaced it.',
  })
  awaitingSelfRestart: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  startedAt: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  completedAt: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  errorMessage: string | null;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiPropertyOptional({
    nullable: true,
    description: 'Who started it. Null for an update started by no person.',
  })
  userId: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      '2 for a planned update with phases; 1 for an update that moved images only.',
  })
  schema: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  planId?: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  k3sVersion?: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'True when the update was applied without the backup, by an acknowledgement.',
  })
  withoutBackup?: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ type: () => [PlatformUpdatePhaseDto] })
  phases?: PlatformUpdatePhaseDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  failedPhase?: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    nullable: true,
    description:
      'What a person can do after a failure. Nothing is rolled back on its own.',
  })
  guidance?: string | null;
}

export class PlatformUpdateNodeStateDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  name: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['server', 'agent'] })
  role: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  fromVersion: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  version: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['pending', 'upgrading', 'done', 'failed'] })
  status: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  message?: string;
}

export class PlatformUpdatePhaseClusterDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  clusterId: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  clusterName: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['control', 'workload'] })
  clusterType: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['pending', 'running', 'done', 'skipped', 'failed'] })
  status: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  planId?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ type: [String] })
  wrote?: string[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  error?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    type: [String],
    description: 'K3s: the minor versions this cluster passes through.',
  })
  steps?: string[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ description: 'K3s: the step it is on.' })
  stepIndex?: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ type: [PlatformUpdateNodeStateDto] })
  nodes?: PlatformUpdateNodeStateDto[];
}

export class PlatformUpdateCheckDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  name: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  ok: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  detail?: string;
}

export class PlatformUpdatePhaseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['backup', 'manifests', 'images', 'k3s', 'verify'] })
  key: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  title: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['pending', 'running', 'done', 'skipped', 'failed'] })
  status: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  startedAt: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  finishedAt: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    nullable: true,
    description: 'When the watchdog calls this phase stalled.',
  })
  deadlineAt: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    nullable: true,
    description: 'Backup: the backup this update took first.',
  })
  backupJobId?: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ type: [PlatformUpdatePhaseClusterDto] })
  clusters?: PlatformUpdatePhaseClusterDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ type: [PlatformUpdateCheckDto] })
  checks?: PlatformUpdateCheckDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  message?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  error?: string;
}
