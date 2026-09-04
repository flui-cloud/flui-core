import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ApplicationEntity } from '../entities/application.entity';
import { ApplicationResourceKind } from '../enums/application-resource-kind.enum';
import {
  DockerImageSourceConfig,
  GitBuildSourceConfig,
  ApplicationHealthProbe,
  ApplicationVolume,
  ApplicationHpaBehavior,
} from '../interfaces/source-config.interface';
import { getProjectPath } from '../../../common/utils/project-root.util';
import { FrameworkType } from '../../frameworks/framework-core/enums/framework-type.enum';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { renderableEnv } from '../utils/env-write.util';

export interface GeneratedManifest {
  kind: ApplicationResourceKind;
  name: string;
  apiVersion: string;
  yaml: string;
}

export type CronConcurrencyPolicy = 'Allow' | 'Forbid' | 'Replace';

export interface CronJobManifestSpec {
  /** DNS-1123 CronJob resource name (already sanitized; `<slug>-<jobname>`). */
  name: string;
  /** Logical job name the user refers to (label + DTO), without the slug prefix. */
  displayName: string;
  /** Standard cron expression, e.g. `0 3 * * *`. */
  schedule: string;
  /** Shell command run via `/bin/sh -c`. */
  command: string;
  /** IANA timezone, e.g. `Europe/Rome`. Omit for the cluster's local time. */
  timezone?: string;
  concurrencyPolicy?: CronConcurrencyPolicy;
  suspend?: boolean;
}

/**
 * A container that rides alongside the application's own, for the length of
 * the pod's life.
 *
 * Introduced for continuous backup of engines that have no equivalent of
 * Postgres's `archive_command`: MariaDB writes its binary logs and forgets
 * them, so something has to be reading continuously, and kubelet is the only
 * supervisor that restarts it, counts the restarts and keeps its logs. Kept
 * general because the same seam is what an APM agent would need.
 */
export interface SidecarSpec {
  name: string;
  image: string;
  command?: string[];
  env?: Array<{
    name: string;
    value?: string;
    secretRef?: { name: string; key: string };
  }>;
  /** Volumes of the pod this sidecar also mounts, by name. */
  mounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
  cpuRequest?: string;
  memoryRequest?: string;
  cpuLimit?: string;
  memoryLimit?: string;
}

function sidecarCommandLines(s: SidecarSpec): string[] {
  if (!s.command?.length) return [];
  return [
    '          command:',
    ...s.command.map((part) => `            - ${JSON.stringify(part)}`),
  ];
}

function sidecarEnvLines(s: SidecarSpec): string[] {
  if (!s.env?.length) return [];
  return [
    '          env:',
    ...s.env.flatMap((e) => [
      `            - name: ${e.name}`,
      ...(e.secretRef
        ? [
            '              valueFrom:',
            '                secretKeyRef:',
            `                  name: ${e.secretRef.name}`,
            `                  key: ${e.secretRef.key}`,
          ]
        : [`              value: ${JSON.stringify(e.value ?? '')}`]),
    ]),
  ];
}

function sidecarMountLines(s: SidecarSpec): string[] {
  if (!s.mounts?.length) return [];
  return [
    '          volumeMounts:',
    ...s.mounts.flatMap((m) => [
      `            - name: ${m.name}`,
      `              mountPath: ${m.mountPath}`,
      ...(m.readOnly ? ['              readOnly: true'] : []),
    ]),
  ];
}

@Injectable()
export class ApplicationManifestGeneratorService {
  private readonly logger = new Logger(
    ApplicationManifestGeneratorService.name,
  );

  constructor(private readonly encryptionService: EncryptionService) {}

  generateForDockerImage(
    app: ApplicationEntity,
    imagePullSecretName?: string,
    imageRefOverride?: string,
  ): GeneratedManifest[] {
    const config = app.sourceConfig as DockerImageSourceConfig;
    const manifests: GeneratedManifest[] = [];

    // Apply order matters: dependencies (ConfigMap/Secret/PVC) must exist
    // before the Deployment so that the scheduler doesn't fail the first
    // placement attempt and enter exponential backoff.
    const rendered = renderableEnv(app.env);

    if (rendered.some((e) => !e.secret && !e.externalSecretRef)) {
      manifests.push(this.generateConfigMap(app));
    }

    if (
      rendered.some((e) => e.secret && !e.externalSecretRef) ||
      app.configFiles?.length
    ) {
      manifests.push(this.generateSecret(app));
    }

    const isStatefulSet = app.workloadKind === 'StatefulSet';

    if (app.volumes?.length && !isStatefulSet) {
      for (const v of app.volumes) {
        manifests.push(this.generatePvc(app, v));
      }
    }

    if (app.port) {
      manifests.push(this.generateService(app));
      if (isStatefulSet) {
        manifests.push(this.generateHeadlessService(app));
      }
    }

    if (isStatefulSet) {
      manifests.push(
        this.generateStatefulSet(
          app,
          config,
          imagePullSecretName,
          imageRefOverride,
        ),
      );
    } else {
      manifests.push(
        this.generateDeployment(
          app,
          config,
          imagePullSecretName,
          imageRefOverride,
        ),
      );
    }

    if (app.scaling?.enabled && !isStatefulSet) {
      manifests.push(this.generateHpa(app));
    }

    this.logger.log(
      `generateForDockerImage(${app.slug}): ${manifests.length} manifests; volumes=${app.volumes?.length ?? 0} workload=${app.workloadKind ?? 'Deployment'} scaling.enabled=${app.scaling?.enabled ?? false}`,
    );

    return manifests;
  }

  /**
   * Resolve the container image for a deploy. For git_build apps `app.imageRef`
   * is the authoritative build output; `sourceConfig.imageRef` can be a stale
   * fossil from an earlier deploy, so it must NOT take precedence (that fossil is
   * how a monorepo app ends up rolling out a bare `{repo}:{sha}` that never
   * existed). docker_image apps carry the image in sourceConfig.imageRef.
   *
   * Defensive guard: for a monorepo git_build app (subPath set) the GHCR package
   * is `{repo}/{subPath}`; refuse to deploy an image missing that segment rather
   * than shipping a guaranteed ImagePullBackOff.
   */
  private resolveDeployImageRef(
    app: ApplicationEntity,
    config: DockerImageSourceConfig,
    override?: string,
  ): string {
    const source = app.sourceConfig as GitBuildSourceConfig | undefined;
    const isGitBuild = source?.type === 'git_build';
    // git_build reads ONLY the desired-image authority (app.imageRef, set by
    // setDesiredImage). docker_image keeps sourceConfig.imageRef as its input.
    const imageRef =
      override || (isGitBuild ? app.imageRef : config.imageRef || app.imageRef);

    if (isGitBuild && source?.subPath && imageRef) {
      const segment = `/${source.subPath.toLowerCase()}:`;
      if (!imageRef.toLowerCase().includes(segment)) {
        throw new Error(
          `Refusing to deploy ${app.slug}: image "${imageRef}" is missing the ` +
            `monorepo subPath "${source.subPath}" — the GHCR package ` +
            `{repo}/${source.subPath} is what the workflow pushes. This is a ` +
            `stale/mis-composed imageRef.`,
        );
      }
    }
    return imageRef;
  }

  private generateDeployment(
    app: ApplicationEntity,
    config: DockerImageSourceConfig,
    imagePullSecretName?: string,
    imageRefOverride?: string,
  ): GeneratedManifest {
    const imageRef = this.resolveDeployImageRef(app, config, imageRefOverride);
    const labels = this.buildLabels(app);
    const annotations = this.buildAnnotations(app);

    const cpuRequest = app.resources?.cpu?.request ?? '100m';
    const cpuLimit = app.resources?.cpu?.limit ?? '500m';
    const memRequest = app.resources?.memory?.request ?? '128Mi';
    const memLimit = app.resources?.memory?.limit ?? '256Mi';

    const template = this.loadTemplate('deployment.yaml');
    const yaml = template
      .replaceAll('{{SLUG}}', app.slug)
      .replaceAll('{{NAMESPACE}}', app.k8sNamespace)
      .replaceAll('{{LABELS_BLOCK}}', this.renderLabelsBlock(labels))
      .replaceAll('{{POD_LABELS_BLOCK}}', this.renderLabelsBlock(labels, 8))
      .replaceAll('{{ANNOTATIONS_BLOCK}}', this.renderLabelsBlock(annotations))
      .replaceAll('{{REPLICAS}}', String(app.replicas ?? 1))
      .replaceAll('{{IMAGE}}', imageRef)
      .replaceAll('{{PULL_POLICY}}', config.pullPolicy || 'IfNotPresent')
      .replaceAll(
        '{{POD_ANNOTATIONS_BLOCK}}',
        this.renderLabelsBlock(this.buildPodAnnotations(app, config), 8),
      )
      .replaceAll('{{PORTS_BLOCK}}', this.renderPortsBlock(app.port))
      .replaceAll('{{ENV_BLOCK}}', this.renderEnvBlock(app))
      .replaceAll('{{CPU_REQUEST}}', cpuRequest)
      .replaceAll('{{CPU_LIMIT}}', cpuLimit)
      .replaceAll('{{MEMORY_REQUEST}}', memRequest)
      .replaceAll('{{MEMORY_LIMIT}}', memLimit)
      .replaceAll(
        '{{READINESS_PROBE_BLOCK}}',
        this.renderReadinessProbeBlock(app),
      )
      .replaceAll('{{VOLUME_MOUNTS_BLOCK}}', this.renderVolumeMountsBlock(app))
      .replaceAll('{{SIDECARS_BLOCK}}', this.renderSidecarsBlock(app))
      .replaceAll('{{VOLUMES_BLOCK}}', this.renderVolumesBlock(app))
      .replaceAll(
        '{{IMAGE_PULL_SECRETS_BLOCK}}',
        this.renderImagePullSecretsBlock(imagePullSecretName),
      )
      .replaceAll(
        '{{NODE_PLACEMENT_BLOCK}}',
        this.renderNodePlacementBlock(app),
      )
      .replaceAll(
        '{{POD_SECURITY_CONTEXT_BLOCK}}',
        this.renderPodSecurityContextBlock(app),
      )
      .replaceAll(
        '{{CONTAINER_SECURITY_CONTEXT_BLOCK}}',
        this.renderContainerSecurityContextBlock(app),
      )
      .replaceAll('{{COMMAND_OVERRIDE_BLOCK}}', this.renderCommandBlock(app));

    return {
      kind: ApplicationResourceKind.DEPLOYMENT,
      name: app.slug,
      apiVersion: 'apps/v1',
      yaml,
    };
  }

  private generateStatefulSet(
    app: ApplicationEntity,
    config: DockerImageSourceConfig,
    imagePullSecretName?: string,
    imageRefOverride?: string,
  ): GeneratedManifest {
    const imageRef = this.resolveDeployImageRef(app, config, imageRefOverride);
    const labels = this.buildLabels(app);
    const annotations = this.buildAnnotations(app);

    const cpuRequest = app.resources?.cpu?.request ?? '100m';
    const cpuLimit = app.resources?.cpu?.limit ?? '500m';
    const memRequest = app.resources?.memory?.request ?? '128Mi';
    const memLimit = app.resources?.memory?.limit ?? '256Mi';

    const template = this.loadTemplate('statefulset.yaml');
    const yaml = template
      .replaceAll('{{SLUG}}', app.slug)
      .replaceAll('{{NAMESPACE}}', app.k8sNamespace)
      .replaceAll('{{LABELS_BLOCK}}', this.renderLabelsBlock(labels))
      .replaceAll('{{POD_LABELS_BLOCK}}', this.renderLabelsBlock(labels, 8))
      .replaceAll('{{ANNOTATIONS_BLOCK}}', this.renderLabelsBlock(annotations))
      .replaceAll('{{REPLICAS}}', String(app.replicas ?? 1))
      .replaceAll('{{IMAGE}}', imageRef)
      .replaceAll('{{PULL_POLICY}}', config.pullPolicy || 'IfNotPresent')
      .replaceAll(
        '{{POD_ANNOTATIONS_BLOCK}}',
        this.renderLabelsBlock(this.buildPodAnnotations(app, config), 8),
      )
      .replaceAll('{{PORTS_BLOCK}}', this.renderPortsBlock(app.port))
      .replaceAll('{{ENV_BLOCK}}', this.renderEnvBlock(app))
      .replaceAll('{{CPU_REQUEST}}', cpuRequest)
      .replaceAll('{{CPU_LIMIT}}', cpuLimit)
      .replaceAll('{{MEMORY_REQUEST}}', memRequest)
      .replaceAll('{{MEMORY_LIMIT}}', memLimit)
      .replaceAll(
        '{{READINESS_PROBE_BLOCK}}',
        this.renderReadinessProbeBlock(app),
      )
      .replaceAll('{{VOLUME_MOUNTS_BLOCK}}', this.renderVolumeMountsBlock(app))
      .replaceAll('{{SIDECARS_BLOCK}}', this.renderSidecarsBlock(app))
      .replaceAll(
        '{{CONFIG_VOLUMES_BLOCK}}',
        this.renderConfigVolumesBlock(app),
      )
      .replaceAll(
        '{{VOLUME_CLAIM_TEMPLATES_BLOCK}}',
        this.renderVolumeClaimTemplatesBlock(app),
      )
      .replaceAll(
        '{{IMAGE_PULL_SECRETS_BLOCK}}',
        this.renderImagePullSecretsBlock(imagePullSecretName),
      )
      .replaceAll(
        '{{NODE_PLACEMENT_BLOCK}}',
        this.renderNodePlacementBlock(app),
      )
      .replaceAll(
        '{{POD_SECURITY_CONTEXT_BLOCK}}',
        this.renderPodSecurityContextBlock(app),
      )
      .replaceAll(
        '{{CONTAINER_SECURITY_CONTEXT_BLOCK}}',
        this.renderContainerSecurityContextBlock(app),
      )
      .replaceAll('{{COMMAND_OVERRIDE_BLOCK}}', this.renderCommandBlock(app));

    return {
      kind: ApplicationResourceKind.STATEFUL_SET,
      name: app.slug,
      apiVersion: 'apps/v1',
      yaml,
    };
  }

  /**
   * Build a CronJob for a scheduled job attached to an app. Reuses the app's
   * image, env (referencing the same ConfigMap/Secret as the Deployment, so it
   * stays in sync when variables change), resources, security context and node
   * placement — only the command and schedule are per-job. App PVCs are NOT
   * mounted: a ReadWriteOnce volume held by the running Deployment pod would
   * multi-attach-fail the cron pod on another node; scheduled jobs talk to the
   * app's dependencies over the network (env-provided connection strings).
   *
   * The pod spec sits two levels deeper than in a Deployment
   * (jobTemplate.spec.template.spec), so the shared block renderers — which emit
   * fixed Deployment-depth indentation — are re-indented by +4 spaces.
   */
  generateCronJob(
    app: ApplicationEntity,
    spec: CronJobManifestSpec,
    imagePullSecretName?: string,
    imageRefOverride?: string,
  ): GeneratedManifest {
    const config = app.sourceConfig as DockerImageSourceConfig;
    const imageRef = this.resolveDeployImageRef(app, config, imageRefOverride);

    const labels = {
      ...this.buildLabels(app),
      'flui.cloud/resource': 'scheduled-job',
      'flui.cloud/scheduled-job': spec.displayName,
    };

    const cpuRequest = app.resources?.cpu?.request ?? '100m';
    const cpuLimit = app.resources?.cpu?.limit ?? '500m';
    const memRequest = app.resources?.memory?.request ?? '128Mi';
    const memLimit = app.resources?.memory?.limit ?? '256Mi';

    const timezoneLine = spec.timezone
      ? `  timeZone: ${JSON.stringify(spec.timezone)}`
      : '';

    const escapedCommand = spec.command
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"');
    const commandBlock = [
      '              command: ["/bin/sh", "-c"]',
      '              args:',
      `                - "${escapedCommand}"`,
    ].join('\n');

    const template = this.loadTemplate('cronjob.yaml');
    const yaml = template
      .replaceAll('{{NAME}}', spec.name)
      .replaceAll('{{SLUG}}', app.slug)
      .replaceAll('{{NAMESPACE}}', app.k8sNamespace)
      .replaceAll('{{LABELS_BLOCK}}', this.renderLabelsBlock(labels))
      .replaceAll('{{JOB_LABELS_BLOCK}}', this.renderLabelsBlock(labels, 8))
      .replaceAll('{{POD_LABELS_BLOCK}}', this.renderLabelsBlock(labels, 12))
      .replaceAll('{{SCHEDULE}}', spec.schedule)
      .replaceAll('{{TIMEZONE_LINE}}', timezoneLine)
      .replaceAll('{{CONCURRENCY_POLICY}}', spec.concurrencyPolicy ?? 'Forbid')
      .replaceAll('{{SUSPEND}}', String(spec.suspend ?? false))
      .replaceAll('{{IMAGE}}', imageRef)
      .replaceAll('{{PULL_POLICY}}', config.pullPolicy || 'IfNotPresent')
      .replaceAll(
        '{{NODE_PLACEMENT_BLOCK}}',
        this.reindent(this.renderNodePlacementBlock(app), 4),
      )
      .replaceAll(
        '{{POD_SECURITY_CONTEXT_BLOCK}}',
        this.reindent(this.renderPodSecurityContextBlock(app), 4),
      )
      .replaceAll(
        '{{IMAGE_PULL_SECRETS_BLOCK}}',
        this.reindent(this.renderImagePullSecretsBlock(imagePullSecretName), 4),
      )
      .replaceAll(
        '{{CONTAINER_SECURITY_CONTEXT_BLOCK}}',
        this.reindent(this.renderContainerSecurityContextBlock(app), 4),
      )
      .replaceAll('{{COMMAND_BLOCK}}', commandBlock)
      .replaceAll('{{ENV_BLOCK}}', this.reindent(this.renderEnvBlock(app), 4))
      .replaceAll('{{CPU_REQUEST}}', cpuRequest)
      .replaceAll('{{CPU_LIMIT}}', cpuLimit)
      .replaceAll('{{MEMORY_REQUEST}}', memRequest)
      .replaceAll('{{MEMORY_LIMIT}}', memLimit);

    return {
      kind: ApplicationResourceKind.CRON_JOB,
      name: spec.name,
      apiVersion: 'batch/v1',
      yaml,
    };
  }

  /** Prefix every non-empty line with `extra` spaces; empty blocks stay empty. */
  private reindent(block: string, extra: number): string {
    if (!block) return '';
    const pad = ' '.repeat(extra);
    return block
      .split('\n')
      .map((line) => (line ? pad + line : line))
      .join('\n');
  }

  private generateService(app: ApplicationEntity): GeneratedManifest {
    const labels = this.buildLabels(app);

    const template = this.loadTemplate('service.yaml');
    const yaml = template
      .replaceAll('{{SLUG}}', app.slug)
      .replaceAll('{{NAMESPACE}}', app.k8sNamespace)
      .replaceAll('{{LABELS_BLOCK}}', this.renderLabelsBlock(labels))
      .replaceAll('{{PORT}}', String(app.port));

    return {
      kind: ApplicationResourceKind.SERVICE,
      name: `${app.slug}-svc`,
      apiVersion: 'v1',
      yaml,
    };
  }

  private generateHeadlessService(app: ApplicationEntity): GeneratedManifest {
    const labels = this.buildLabels(app);

    const template = this.loadTemplate('headless-service.yaml');
    const yaml = template
      .replaceAll('{{SLUG}}', app.slug)
      .replaceAll('{{NAMESPACE}}', app.k8sNamespace)
      .replaceAll('{{LABELS_BLOCK}}', this.renderLabelsBlock(labels))
      .replaceAll('{{PORT}}', String(app.port));

    return {
      kind: ApplicationResourceKind.SERVICE,
      name: `${app.slug}-headless`,
      apiVersion: 'v1',
      yaml,
    };
  }

  private generateConfigMap(app: ApplicationEntity): GeneratedManifest {
    const labels = this.buildLabels(app);
    const nonSecretEnv = renderableEnv(app.env).filter(
      (e) => !e.secret && !e.externalSecretRef,
    );

    const template = this.loadTemplate('configmap.yaml');
    const yaml = template
      .replaceAll('{{SLUG}}', app.slug)
      .replaceAll('{{NAMESPACE}}', app.k8sNamespace)
      .replaceAll('{{LABELS_BLOCK}}', this.renderLabelsBlock(labels))
      .replaceAll(
        '{{CONFIG_DATA_BLOCK}}',
        this.renderConfigDataBlock(nonSecretEnv),
      );

    return {
      kind: ApplicationResourceKind.CONFIG_MAP,
      name: `${app.slug}-config`,
      apiVersion: 'v1',
      yaml,
    };
  }

  private generateSecret(app: ApplicationEntity): GeneratedManifest {
    const labels = this.buildLabels(app);
    const secretEnv = renderableEnv(app.env).filter(
      (e) => e.secret && !e.externalSecretRef,
    );

    const secretData = [
      this.renderSecretDataBlock(secretEnv),
      this.renderConfigFileSecretData(app),
    ]
      .filter(Boolean)
      .join('\n');

    const template = this.loadTemplate('secret.yaml');
    const yaml = template
      .replaceAll('{{SLUG}}', app.slug)
      .replaceAll('{{NAMESPACE}}', app.k8sNamespace)
      .replaceAll('{{LABELS_BLOCK}}', this.renderLabelsBlock(labels))
      .replaceAll('{{SECRET_DATA_BLOCK}}', secretData);

    return {
      kind: ApplicationResourceKind.SECRET,
      name: `${app.slug}-secret`,
      apiVersion: 'v1',
      yaml,
    };
  }

  private generateHpa(app: ApplicationEntity): GeneratedManifest {
    const labels = this.buildLabels(app);

    const minReplicas =
      app.scaling?.horizontal?.min ?? app.scaling?.minReplicas ?? 1;
    const maxReplicas =
      app.scaling?.horizontal?.max ?? app.scaling?.maxReplicas ?? 5;

    const template = this.loadTemplate('hpa.yaml');
    const yaml = template
      .replaceAll('{{SLUG}}', app.slug)
      .replaceAll('{{NAMESPACE}}', app.k8sNamespace)
      .replaceAll('{{LABELS_BLOCK}}', this.renderLabelsBlock(labels))
      .replaceAll('{{MIN_REPLICAS}}', String(minReplicas))
      .replaceAll('{{MAX_REPLICAS}}', String(maxReplicas))
      .replaceAll('{{METRICS_BLOCK}}', this.renderMetricsBlock(app))
      .replaceAll(
        '{{BEHAVIOR_BLOCK}}',
        this.renderHpaBehaviorBlock(app.scaling?.horizontal?.behavior),
      );

    return {
      kind: ApplicationResourceKind.HORIZONTAL_POD_AUTOSCALER,
      name: `${app.slug}-hpa`,
      apiVersion: 'autoscaling/v2',
      yaml,
    };
  }

  private generatePvc(
    app: ApplicationEntity,
    volume: ApplicationVolume,
  ): GeneratedManifest {
    const labels = this.buildLabels(app);
    const size = volume.size ?? '1Gi';

    const storageClass = this.resolveStorageClass(app, volume);
    const storageClassBlock = storageClass
      ? `  storageClassName: ${storageClass}`
      : '';

    const template = this.loadTemplate('pvc.yaml');
    const yaml = template
      .replaceAll('{{SLUG}}', app.slug)
      .replaceAll('{{VOLUME_NAME}}', volume.name)
      .replaceAll('{{NAMESPACE}}', app.k8sNamespace)
      .replaceAll('{{LABELS_BLOCK}}', this.renderLabelsBlock(labels))
      .replaceAll('{{SIZE}}', size)
      .replaceAll('{{STORAGE_CLASS_BLOCK}}', storageClassBlock);

    return {
      kind: ApplicationResourceKind.PERSISTENT_VOLUME_CLAIM,
      name: `${app.slug}-${volume.name}`,
      apiVersion: 'v1',
      yaml,
    };
  }

  // ─── Template loading ───────────────────────────────────────────────────────

  private loadTemplate(filename: string): string {
    const templatePath = getProjectPath(
      'src',
      'modules',
      'applications',
      'templates',
      'k8s',
      filename,
    );
    return readFileSync(templatePath, 'utf-8');
  }

  // ─── Block renderers ────────────────────────────────────────────────────────

  private renderLabelsBlock(
    labels: Record<string, string>,
    indent = 4,
  ): string {
    return Object.entries(labels)
      .map(([k, v]) => `${' '.repeat(indent)}${k}: "${v}"`)
      .join('\n');
  }

  private renderImagePullSecretsBlock(secretName?: string): string {
    if (!secretName) return '';
    return `      imagePullSecrets:\n        - name: ${secretName}`;
  }

  /**
   * Dedicated apps default to the node-local `flui-local` class so writes hit
   * the worker's own disk even when the default `local-path` is NFS-backed. An
   * explicit per-volume class always wins.
   */
  private resolveStorageClass(
    app: ApplicationEntity,
    volume: ApplicationVolume,
  ): string | undefined {
    if (volume.storageClass) return volume.storageClass;
    if (app.persistenceScope === 'dedicated') return 'flui-local';
    return undefined;
  }

  private renderNodePlacementBlock(app: ApplicationEntity): string {
    if (app.persistenceScope !== 'dedicated') return '';
    if (app.dedicatedNodeName) {
      return (
        '      nodeSelector:\n' +
        `        kubernetes.io/hostname: "${app.dedicatedNodeName}"`
      );
    }
    // master escape hatch — workers are assigned via dedicatedNodeName above
    if (app.allowMasterPlacement) {
      return (
        '      nodeSelector:\n' +
        '        node-role.kubernetes.io/control-plane: "true"\n' +
        '      tolerations:\n' +
        '        - key: node-role.kubernetes.io/control-plane\n' +
        '          operator: Exists\n' +
        '          effect: NoSchedule\n' +
        '        - key: node-role.kubernetes.io/master\n' +
        '          operator: Exists\n' +
        '          effect: NoSchedule'
      );
    }
    return '';
  }

  /**
   * Resolve the effective start command to override the image's baked CMD.
   * Priority: user override → auto-detected (from build) → framework fallback → undefined (no override).
   */
  private getStartCommandOverride(app: ApplicationEntity): string | undefined {
    // Priority 1: explicit user override
    if (app.startCommand) return app.startCommand;

    // Priority 2: auto-detected + corrected by build processor (already on app.startCommand above,
    // or not yet set for apps built before this feature — fall through to framework fallback).

    // Priority 3: framework-based fallback for images built before auto-detection was introduced
    const framework = (app.sourceConfig as GitBuildSourceConfig)?.framework;
    if (framework === FrameworkType.SPRING_BOOT) {
      return 'java $JAVA_OPTS -Dserver.port=$PORT -jar $(ls /app/build/libs/*.jar /app/*/build/libs/*.jar 2>/dev/null | grep -v plain | head -1)';
    }

    return undefined; // no override — K8s uses the image's baked CMD
  }

  /** Pod-level securityContext; emits only declared fields, nothing when the app declares none. */
  private renderPodSecurityContextBlock(app: ApplicationEntity): string {
    const sc = app.securityContext;
    if (!sc) return '';
    const lines: string[] = ['      securityContext:'];
    if (sc.fsGroup !== undefined) {
      lines.push(
        `        fsGroup: ${sc.fsGroup}`,
        '        fsGroupChangePolicy: OnRootMismatch',
      );
    }
    if (sc.runAsUser !== undefined)
      lines.push(`        runAsUser: ${sc.runAsUser}`);
    if (sc.runAsGroup !== undefined)
      lines.push(`        runAsGroup: ${sc.runAsGroup}`);
    if (sc.runAsNonRoot !== undefined)
      lines.push(`        runAsNonRoot: ${sc.runAsNonRoot}`);
    if (sc.hardened) {
      lines.push('        seccompProfile:', '          type: RuntimeDefault');
    }
    return lines.length > 1 ? lines.join('\n') : '';
  }

  /** Container-level securityContext, only when `hardened`: drop all caps, no privilege escalation. */
  private renderContainerSecurityContextBlock(app: ApplicationEntity): string {
    if (!app.securityContext?.hardened) return '';
    return [
      '          securityContext:',
      '            allowPrivilegeEscalation: false',
      '            capabilities:',
      '              drop:',
      '                - ALL',
    ].join('\n');
  }

  /**
   * Render the command/args override block for the container spec. Empty string
   * if no override. `command` (exec-form argv) wins over `startCommand` and runs
   * without a shell — required for distroless images (no /bin/sh).
   */
  private renderCommandBlock(app: ApplicationEntity): string {
    if (app.command?.length) {
      return `          command: ${JSON.stringify(app.command)}`;
    }
    const startCommand = this.getStartCommandOverride(app);
    if (!startCommand) return '';
    const escaped = startCommand
      .replaceAll(String.raw`\\`, String.raw`\\`)
      .replaceAll('"', String.raw`\"`);
    return (
      '          command: ["/bin/sh", "-c"]\n' +
      '          args:\n' +
      `            - "${escaped}"`
    );
  }

  private renderPortsBlock(port?: number): string {
    if (!port) return '';
    return (
      '          ports:\n' +
      `            - containerPort: ${port}\n` +
      '              protocol: TCP'
    );
  }

  private renderEnvBlock(app: ApplicationEntity): string {
    // A pending key is skipped rather than bound: `secretKeyRef` to a key that
    // is not in the Secret puts the pod in CreateContainerConfigError, and
    // writing it as an empty string would hand the container a credential that
    // is blank but present. Neither is what "waiting for a person" means.
    const env = renderableEnv(app.env);
    if (!env.length) return '';
    const lines: string[] = ['          env:'];
    for (const e of env) {
      lines.push(`            - name: ${e.name}`, `              valueFrom:`);
      if (e.externalSecretRef) {
        lines.push(
          `                secretKeyRef:`,
          `                  name: ${e.externalSecretRef.secretName}`,
          `                  key: ${e.externalSecretRef.key}`,
        );
      } else if (e.secret) {
        lines.push(
          `                secretKeyRef:`,
          `                  name: ${app.slug}-secret`,
          `                  key: ${e.name}`,
        );
      } else {
        lines.push(
          `                configMapKeyRef:`,
          `                  name: ${app.slug}-config`,
          `                  key: ${e.name}`,
        );
      }
    }
    return lines.join('\n');
  }

  private renderConfigDataBlock(
    envVars: Array<{ name: string; value: string }>,
  ): string {
    return envVars
      .map((e) => `  ${e.name}: ${JSON.stringify(e.value)}`)
      .join('\n');
  }

  private renderSecretDataBlock(
    envVars: Array<{ name: string; value: string }>,
  ): string {
    // `e.value` is AES-GCM encrypted at rest (ApplicationService.create wraps
    // every secret=true env var via EncryptionService.encrypt). Before writing
    // it to the Kubernetes Secret — which already does its own base64 encoding
    // — we MUST decrypt back to plaintext. Otherwise the container receives
    // the ciphertext as the env value and apps with strict validation
    // (e.g. Homarr's 64-hex-char SECRET_ENCRYPTION_KEY) reject it with
    // "Invalid environment variables". Apps that accept any opaque token
    // (e.g. Vaultwarden's ADMIN_TOKEN) appear to "work" but the token the
    // user sees in the Flui dashboard would not match what the app accepts.
    return envVars
      .map((e) => {
        const plaintext = this.decryptIfEncrypted(e.value);
        // Quoted: an empty value must stay an empty STRING — bare it parses as
        // YAML null and the API server drops the key, breaking secretKeyRef.
        return `  ${e.name}: "${Buffer.from(plaintext).toString('base64')}"`;
      })
      .join('\n');
  }

  /**
   * Decrypt when the value looks like our AES-GCM envelope (iv+authTag+
   * ciphertext, base64). On failure (e.g. a plaintext snuck in), log and
   * fall back to the raw value — we'd rather ship a misconfigured secret
   * the user can spot than crash the whole deploy.
   */
  private decryptIfEncrypted(value: string): string {
    try {
      return this.encryptionService.decrypt(value);
    } catch (err) {
      this.logger.warn(
        `renderSecretDataBlock: failed to decrypt env value (${
          err instanceof Error ? err.message : String(err)
        }); using raw value. This usually means an env was marked secret=true but stored in plaintext.`,
      );
      return value;
    }
  }

  private configFileName(path: string, index: number): string {
    return path.split('/').pop() || `file-${index}`;
  }

  private renderConfigFileSecretData(app: ApplicationEntity): string {
    return (app.configFiles ?? [])
      .map(
        (f, i) => `  file-${i}: ${Buffer.from(f.content).toString('base64')}`,
      )
      .join('\n');
  }

  private renderConfigFileMountLines(app: ApplicationEntity): string[] {
    return (app.configFiles ?? []).flatMap((f, i) => [
      `            - name: cfgfile-${i}`,
      `              mountPath: ${f.path}`,
      `              subPath: ${this.configFileName(f.path, i)}`,
      `              readOnly: true`,
    ]);
  }

  private renderConfigFileVolumeLines(app: ApplicationEntity): string[] {
    return (app.configFiles ?? []).flatMap((f, i) => [
      `        - name: cfgfile-${i}`,
      `          secret:`,
      `            secretName: ${app.slug}-secret`,
      `            items:`,
      `              - key: file-${i}`,
      `                path: ${this.configFileName(f.path, i)}`,
    ]);
  }

  /**
   * Renders the sidecars an application declares, as ordinary containers.
   *
   * Ordinary rather than native sidecars (`initContainers` with
   * `restartPolicy: Always`) because the shipper must not gate the workload's
   * readiness: a database whose backup companion cannot start is still a
   * database people need, and a backup that keeps a database from starting has
   * inverted its own purpose. Ordering is the shipper's problem to tolerate,
   * not the application's problem to wait for.
   */
  private renderSidecarsBlock(app: ApplicationEntity): string {
    const sidecars = (app as { sidecars?: SidecarSpec[] }).sidecars ?? [];
    if (sidecars.length === 0) return '';
    return sidecars
      .flatMap((s) => [
        `        - name: ${s.name}`,
        `          image: "${s.image}"`,
        ...sidecarCommandLines(s),
        ...sidecarEnvLines(s),
        '          resources:',
        '            requests:',
        `              cpu: "${s.cpuRequest ?? '10m'}"`,
        `              memory: "${s.memoryRequest ?? '32Mi'}"`,
        '            limits:',
        `              cpu: "${s.cpuLimit ?? '250m'}"`,
        `              memory: "${s.memoryLimit ?? '256Mi'}"`,
        ...sidecarMountLines(s),
      ])
      .join('\n');
  }

  private renderVolumeMountsBlock(app: ApplicationEntity): string {
    const lines: string[] = [];
    for (const v of app.volumes ?? []) {
      lines.push(
        `            - name: ${v.name}`,
        `              mountPath: ${v.mountPath}`,
      );
    }
    lines.push(...this.renderConfigFileMountLines(app));
    if (!lines.length) return '';
    return ['          volumeMounts:', ...lines].join('\n');
  }

  private renderVolumesBlock(app: ApplicationEntity): string {
    const lines: string[] = [];
    for (const v of app.volumes ?? []) {
      const claimName = v.claimNameOverride ?? `${app.slug}-${v.name}`;
      lines.push(
        `        - name: ${v.name}`,
        `          persistentVolumeClaim:`,
        `            claimName: ${claimName}`,
      );
    }
    lines.push(...this.renderConfigFileVolumeLines(app));
    if (!lines.length) return '';
    return ['      volumes:', ...lines].join('\n');
  }

  private renderConfigVolumesBlock(app: ApplicationEntity): string {
    const lines = this.renderConfigFileVolumeLines(app);
    if (!lines.length) return '';
    return ['      volumes:', ...lines].join('\n');
  }

  private renderVolumeClaimTemplatesBlock(app: ApplicationEntity): string {
    if (!app.volumes?.length) return '';
    const lines: string[] = ['  volumeClaimTemplates:'];
    for (const v of app.volumes) {
      const size = v.size ?? '1Gi';
      lines.push(
        `    - metadata:`,
        `        name: ${v.name}`,
        `      spec:`,
        `        accessModes:`,
        `          - ReadWriteOnce`,
      );
      const storageClass = this.resolveStorageClass(app, v);
      if (storageClass) {
        lines.push(`        storageClassName: ${storageClass}`);
      }
      lines.push(
        `        resources:`,
        `          requests:`,
        `            storage: ${size}`,
      );
    }
    return lines.join('\n');
  }

  private renderHpaBehaviorBlock(
    behavior: ApplicationHpaBehavior | undefined,
  ): string {
    if (!behavior || (!behavior.scaleUp && !behavior.scaleDown)) return '';
    const lines: string[] = ['  behavior:'];
    if (behavior.scaleUp) {
      lines.push(
        '    scaleUp:',
        `      stabilizationWindowSeconds: ${behavior.scaleUp.stabilizationWindowSeconds}`,
        '      policies:',
        '        - type: Pods',
        `          value: ${behavior.scaleUp.step}`,
        '          periodSeconds: 15',
        '      selectPolicy: Max',
      );
    }
    if (behavior.scaleDown) {
      lines.push(
        '    scaleDown:',
        `      stabilizationWindowSeconds: ${behavior.scaleDown.stabilizationWindowSeconds}`,
        '      policies:',
        '        - type: Pods',
        `          value: ${behavior.scaleDown.step}`,
        '          periodSeconds: 60',
        '      selectPolicy: Max',
      );
    }
    return lines.join('\n');
  }

  private renderMetricsBlock(app: ApplicationEntity): string {
    const lines: string[] = [];
    const v2metrics = app.scaling?.horizontal?.metrics;
    if (v2metrics?.length) {
      for (const m of v2metrics) {
        lines.push(
          '    - type: Resource',
          '      resource:',
          `        name: ${m.type}`,
          '        target:',
          '          type: Utilization',
          `          averageUtilization: ${m.utilization}`,
        );
      }
      return lines.join('\n');
    }
    if (app.scaling?.targetCPU) {
      lines.push(
        '    - type: Resource',
        '      resource:',
        '        name: cpu',
        '        target:',
        '          type: Utilization',
        `          averageUtilization: ${app.scaling.targetCPU}`,
      );
    }
    if (app.scaling?.targetMemory) {
      lines.push(
        '    - type: Resource',
        '      resource:',
        '        name: memory',
        '        target:',
        '          type: Utilization',
        `          averageUtilization: ${app.scaling.targetMemory}`,
      );
    }
    return lines.join('\n');
  }

  // ─── Metadata builders ───────────────────────────────────────────────────────

  private buildLabels(app: ApplicationEntity): Record<string, string> {
    return {
      app: app.slug,
      'app.kubernetes.io/name': app.slug,
      'app.kubernetes.io/managed-by': 'flui-cloud',
      'app.kubernetes.io/instance': app.slug,
      'flui-app-id': app.id,
      'flui.cloud/app-kind': app.kind,
      ...app.labels,
    };
  }

  /**
   * Returns the effective health probe for an app.
   * If healthProbe is not explicitly configured, no probe is injected.
   */
  resolveDefaultProbe(app: ApplicationEntity): ApplicationHealthProbe {
    return app.healthProbe ?? { type: 'none' };
  }

  /**
   * Renders the readinessProbe YAML block for a container spec.
   * Returns an empty string if the probe type is 'none' or cannot be determined.
   */
  private renderReadinessProbeBlock(app: ApplicationEntity): string {
    const probe = this.resolveDefaultProbe(app);
    if (probe.type === 'none') return '';

    const initialDelay = probe.initialDelaySeconds ?? 30;
    const period = probe.periodSeconds ?? 30;
    const timeout = probe.timeoutSeconds ?? 5;
    const failureThreshold = probe.failureThreshold ?? 3;
    const indent = '          ';

    const lines: string[] = [`${indent}readinessProbe:`];

    if (probe.type === 'http') {
      const path = probe.httpPath ?? '/';
      const port = probe.httpPort ?? app.port ?? 80;
      const scheme = probe.httpScheme ?? 'HTTP';
      lines.push(
        `${indent}  httpGet:`,
        `${indent}    path: ${path}`,
        `${indent}    port: ${port}`,
        `${indent}    scheme: ${scheme}`,
      );
      const headers = probe.httpHeaders ?? {};
      const headerNames = Object.keys(headers);
      if (headerNames.length) {
        lines.push(`${indent}    httpHeaders:`);
        for (const name of headerNames) {
          lines.push(
            `${indent}      - name: ${name}`,
            `${indent}        value: ${JSON.stringify(String(headers[name]))}`,
          );
        }
      }
    } else if (probe.type === 'tcp') {
      const port = probe.tcpPort ?? app.port ?? 80;
      lines.push(`${indent}  tcpSocket:`, `${indent}    port: ${port}`);
    } else if (probe.type === 'exec') {
      const cmd = probe.execCommand ?? [];
      lines.push(`${indent}  exec:`, `${indent}    command:`);
      for (const part of cmd) {
        // JSON.stringify gives a YAML-safe double-quoted string and escapes
        // any inner quotes/backslashes — avoids the parser interpreting
        // unquoted values like "{{env.X}}" as flow mappings.
        lines.push(`${indent}      - ${JSON.stringify(String(part))}`);
      }
    }

    lines.push(
      `${indent}  initialDelaySeconds: ${initialDelay}`,
      `${indent}  periodSeconds: ${period}`,
      `${indent}  timeoutSeconds: ${timeout}`,
      `${indent}  failureThreshold: ${failureThreshold}`,
    );

    return lines.join('\n');
  }

  private buildAnnotations(app: ApplicationEntity): Record<string, string> {
    return {
      'flui.cloud/revision': String(app.currentRevisionId ? 1 : 0),
    };
  }

  private buildPodAnnotations(
    app: ApplicationEntity,
    config: DockerImageSourceConfig,
  ): Record<string, string> {
    // No `prometheus.io/scrape` here on purpose: it used to be set for every non-TCP
    // app pointing at the app's own port, which made vmagent poll `/metrics` on
    // thousands of ports that serve application traffic. Edge HTTP signals come from
    // Traefik instead; a per-app opt-in lands with the observability manifest block.
    return {
      'flui.cloud/config-hash': this.computeConfigHash(app, config),
    };
  }

  /**
   * Hash the pod-facing config so a rolling update is guaranteed whenever the
   * env list, image, command, or resources change — even when JSON Merge
   * Patch on K8s might otherwise skip a spec update (e.g. ConfigMap keys
   * sparite da `data` non rimosse, oppure spec pod template considerate
   * equivalenti). The hash lands in `spec.template.metadata.annotations`, so
   * any change forces K8s to observe a pod-template diff and restart pods.
   *
   * Included in the hash:
   *   - env (names + values + secret/externalSecretRef descriptors)
   *   - imageRef + pullPolicy
   *   - startCommand (container CMD override)
   *   - resources (cpu/mem request/limit)
   *   - volumes (names + mountPaths + sizes)
   *
   * NOT included: replicas (handled by Deployment spec directly), labels,
   * annotations (we'd get infinite loops), port (contributes only to probe
   * rendering which we already track via env+cmd).
   */
  private computeConfigHash(
    app: ApplicationEntity,
    config: DockerImageSourceConfig,
  ): string {
    const payload = {
      env:
        app.env?.map((e) => ({
          name: e.name,
          value: e.value,
          secret: !!e.secret,
          ext: e.externalSecretRef ?? null,
        })) ?? [],
      image: config.imageRef || app.imageRef || '',
      pullPolicy: config.pullPolicy || 'IfNotPresent',
      cmd: this.getStartCommandOverride(app) ?? null,
      resources: {
        cpuRequest: app.resources?.cpu?.request ?? null,
        cpuLimit: app.resources?.cpu?.limit ?? null,
        memRequest: app.resources?.memory?.request ?? null,
        memLimit: app.resources?.memory?.limit ?? null,
      },
      volumes:
        app.volumes?.map((v) => ({
          name: v.name,
          mountPath: v.mountPath,
          size: v.size ?? null,
          storageClass: v.storageClass ?? null,
        })) ?? [],
    };
    return createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex')
      .slice(0, 16);
  }
}
