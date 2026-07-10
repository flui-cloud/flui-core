import { FrameworkType } from '../../frameworks/framework-core/enums/framework-type.enum';
import { BuildMode } from '../../frameworks/framework-core/enums/build-stage.enum';

export interface DockerImageSourceConfig {
  type: 'docker_image';
  imageRef: string;
  registryAuth?: string;
  pullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
}

export interface GitBuildSourceConfig {
  type: 'git_build';
  repositoryId?: string;
  branch: string;
  gitUrl?: string;
  commitSha?: string;
  framework?: FrameworkType;
  buildMode?: BuildMode;
  dockerfile?: string;
  /**
   * Monorepo image segment: the GHCR package is `{repoName}/{subPath}` (not just
   * `{repoName}`). Set at deploy time when the manifest builds from a subdirectory.
   * The build watcher must include it when composing the rollout imageRef.
   */
  subPath?: string;
  buildPlan?: Record<string, string>;
  lastBuildJobId?: string;
}

export interface HelmChartSourceConfig {
  type: 'helm_chart';
  repoUrl: string;
  chartName: string;
  chartVersion: string;
  valuesYaml?: string;
  valuesOverrides?: Record<string, string>;
}

export interface RawManifestEntry {
  name: string;
  yaml: string;
  order: number;
}

export interface RawManifestSourceConfig {
  type: 'raw_manifest';
  manifests: RawManifestEntry[];
  templateEngine?: 'handlebars' | 'none';
  templateVariables?: Record<string, string>;
}

export type ApplicationSourceConfig =
  | DockerImageSourceConfig
  | GitBuildSourceConfig
  | HelmChartSourceConfig
  | RawManifestSourceConfig;

export interface ApplicationEnvVar {
  name: string;
  value: string;
  secret?: boolean;
  /**
   * When set, the env var is rendered as a Kubernetes `secretKeyRef` pointing
   * to an externally-managed Secret (e.g. the K8s Secret owned by a catalog
   * building block like postgresql). The `value` field is ignored and no
   * value is stored in Flui's DB — the pod reads the secret directly from
   * the referenced K8s Secret at start time, so credentials never leave the
   * cluster.
   */
  externalSecretRef?: {
    secretName: string;
    key: string;
  };
}

export interface ApplicationResources {
  cpu?: { request?: string; limit?: string };
  memory?: { request?: string; limit?: string };
}

/** Pod/container security; only set fields are emitted. Mainly `fsGroup` so non-root images can write a PVC. */
export interface ApplicationSecurityContext {
  fsGroup?: number;
  runAsUser?: number;
  runAsGroup?: number;
  runAsNonRoot?: boolean;
  hardened?: boolean;
}

export interface ApplicationScaling {
  enabled: boolean;
  minReplicas?: number;
  maxReplicas?: number;
  targetCPU?: number;
  targetMemory?: number;
  horizontal?: ApplicationHorizontalScaling;
  vertical?: ApplicationVerticalScaling;
}

export interface ApplicationHorizontalScaling {
  enabled: boolean;
  min?: number;
  max?: number;
  metrics?: ApplicationHpaMetric[];
  behavior?: ApplicationHpaBehavior;
}

export interface ApplicationHpaMetric {
  type: 'cpu' | 'memory';
  utilization: number;
}

export interface ApplicationHpaBehavior {
  scaleUp?: ApplicationHpaBehaviorPolicy;
  scaleDown?: ApplicationHpaBehaviorPolicy;
}

export interface ApplicationHpaBehaviorPolicy {
  stabilizationWindowSeconds: number;
  step: number;
}

export interface ApplicationVerticalScaling {
  enabled: boolean;
  mode: 'Off' | 'Initial' | 'Recreate' | 'Auto';
  bounds?: {
    cpu?: { min: string; max: string };
    memory?: { min: string; max: string };
  };
  updatePolicy?: {
    trigger?: Array<'OOMKilled' | 'CPUThrottling'>;
    cooldownSeconds?: number;
  };
}

export interface ApplicationVolume {
  name: string;
  mountPath: string;
  size?: string;
  storageClass?: string;
  claimNameOverride?: string;
}

export interface ApplicationHealthProbe {
  type: 'http' | 'tcp' | 'exec' | 'none';
  httpPath?: string;
  httpPort?: number;
  httpScheme?: 'HTTP' | 'HTTPS';
  httpHeaders?: Record<string, string>;
  tcpPort?: number;
  execCommand?: string[];
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  failureThreshold?: number;
}
