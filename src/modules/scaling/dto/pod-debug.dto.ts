import { ApiProperty } from '@nestjs/swagger';
import {
  K8sEventSummary,
  SuggestedAction,
} from '../interfaces/crash-diagnosis.interface';

export class PodResourceQuantityDto {
  cpu: string | null;
  memory: string | null;
}

export class PodContainerStateDto {
  running?: { startedAt?: string };
  waiting?: { reason?: string; message?: string };
  terminated?: {
    reason?: string;
    exitCode?: number;
    message?: string;
    startedAt?: string;
    finishedAt?: string;
  };
}

export class PodProbeDto {
  type: 'http' | 'tcp' | 'exec' | null;
  path?: string;
  port?: number | string;
  command?: string[];
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  failureThreshold?: number;
  successThreshold?: number;
}

export class PodEnvVarDto {
  name: string;
  value?: string;
  valueFrom?: {
    kind: 'Secret' | 'ConfigMap';
    name: string;
    key: string;
    exists: boolean;
  };
}

export class PodContainerDebugDto {
  name: string;
  image: string;
  ready: boolean;
  restartCount: number;
  requests: PodResourceQuantityDto;
  limits: PodResourceQuantityDto;
  state: PodContainerStateDto;
  lastState: PodContainerStateDto | null;
  readinessProbe?: PodProbeDto;
  livenessProbe?: PodProbeDto;
  startupProbe?: PodProbeDto;
  env: PodEnvVarDto[];
}

export class PodVolumeDto {
  name: string;
  kind: 'Secret' | 'ConfigMap' | 'PersistentVolumeClaim' | 'EmptyDir' | 'Other';
  resourceName?: string;
  exists?: boolean;
}

export class PodConditionDto {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export class PodSchedulingDto {
  nodeSelector?: Record<string, string>;
  tolerations?: Array<Record<string, unknown>>;
  affinity?: Record<string, unknown>;
}

export class PodDebugInfoDto {
  @ApiProperty()
  name: string;
  @ApiProperty()
  namespace: string;
  @ApiProperty()
  uid: string;
  @ApiProperty({ nullable: true })
  creationTimestamp: string | null;
  @ApiProperty({ type: Object })
  labels: Record<string, string>;
  @ApiProperty({ type: Object })
  annotations: Record<string, string>;
  @ApiProperty({ nullable: true })
  nodeName: string | null;
  @ApiProperty({ nullable: true })
  hostIP: string | null;
  @ApiProperty({ nullable: true })
  podIP: string | null;
  @ApiProperty()
  phase: string;
  @ApiProperty({ nullable: true })
  qosClass: string | null;
  @ApiProperty({ type: [PodConditionDto] })
  conditions: PodConditionDto[];
  @ApiProperty({ type: [PodContainerDebugDto] })
  containers: PodContainerDebugDto[];
  @ApiProperty({ type: [PodVolumeDto] })
  volumes: PodVolumeDto[];
  @ApiProperty({ type: Array })
  events: K8sEventSummary[];
  @ApiProperty({ type: PodSchedulingDto })
  scheduling: PodSchedulingDto;
  @ApiProperty({ nullable: true })
  latestDiagnosisId: string | null;
  @ApiProperty({
    nullable: true,
    description:
      'What the latest open diagnosis of this pod proposes. When its type is `resources`, the change can be applied with POST /applications/:id/crash-diagnoses/:diagnosisId/apply.',
  })
  latestSuggestion: SuggestedAction | null;
}
