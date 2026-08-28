import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AutoscaleActuation } from '../services/autoscale-actuation';

export enum AutoscaleWarningLevel {
  NONE = 'NONE',
  WARN_NEEDS_AUTOSCALE = 'WARN_NEEDS_AUTOSCALE',
  DANGER_NEEDS_SCALE = 'DANGER_NEEDS_SCALE',
}

export class AutoscaleEffectiveThresholdsDto {
  @ApiProperty() scaleUpMemoryPct: number;
  @ApiProperty() scaleUpCpuPct: number;
  @ApiProperty() warnMemoryPct: number;
  @ApiProperty() dangerMemoryPct: number;
  @ApiProperty() warnCpuPct: number;
  @ApiProperty() dangerCpuPct: number;
  @ApiProperty() cooldownSeconds: number;
}

export class AutoscaleMetricsDto {
  @ApiPropertyOptional({ nullable: true })
  memoryPct: number | null;

  @ApiPropertyOptional({ nullable: true })
  cpuPct: number | null;
}

export class PendingPodRequestDto {
  @ApiProperty() name: string;
  @ApiProperty() namespace: string;
  @ApiProperty() cpuMillicores: number;
  @ApiProperty() memoryMi: number;
}

export class UnschedulablePodsDto {
  @ApiProperty() count: number;

  @ApiProperty({ nullable: true })
  oldestWaitingSeconds: number | null;

  @ApiProperty({
    type: PendingPodRequestDto,
    nullable: true,
    description:
      'The largest thing waiting: what an alert has to name on a provider ' +
      'Flui cannot buy from, and what a shape has to hold on one it can.',
  })
  largestRequest: PendingPodRequestDto | null;

  @ApiProperty({
    nullable: true,
    description: "The scheduler's own account of why it could not place it",
  })
  message: string | null;
}

export class AutoscaleStatusDto {
  @ApiProperty() clusterId: string;
  @ApiProperty() autoscalingEnabled: boolean;
  @ApiPropertyOptional() minNodes?: number;
  @ApiPropertyOptional() maxNodes?: number;
  @ApiProperty() currentNodes: number;
  @ApiProperty({ type: AutoscaleMetricsDto }) metrics: AutoscaleMetricsDto;

  /**
   * Null means the cluster could not be asked, which is a different answer
   * from a count of zero and must not be read as calm.
   */
  @ApiPropertyOptional({ type: UnschedulablePodsDto, nullable: true })
  unschedulable: UnschedulablePodsDto | null;

  @ApiProperty({ enum: AutoscaleWarningLevel }) warning: AutoscaleWarningLevel;
  @ApiProperty() warningMessage: string | null;
  @ApiProperty({ enum: AutoscaleActuation }) actuation: AutoscaleActuation;
  @ApiProperty() actuationMessage: string;
  @ApiProperty() nodeProvisioning: boolean;
  @ApiProperty() driven: boolean;
  @ApiProperty({ type: AutoscaleEffectiveThresholdsDto })
  effectiveThresholds: AutoscaleEffectiveThresholdsDto;
}

export class AutoscaleDefaultsDto {
  @ApiProperty() scaleUpMemoryPct: number;
  @ApiProperty() scaleUpCpuPct: number;
  @ApiProperty() warnMemoryPct: number;
  @ApiProperty() dangerMemoryPct: number;
  @ApiProperty() warnCpuPct: number;
  @ApiProperty() dangerCpuPct: number;
  @ApiProperty() cooldownSeconds: number;
  @ApiProperty() defaultMinNodes: number;
  @ApiProperty() defaultMaxNodes: number;
}
