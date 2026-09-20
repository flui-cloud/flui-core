import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as k8s from '@kubernetes/client-node';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { CrashDiagnosesRepository } from '../repositories/crash-diagnoses.repository';
import {
  PodContainerDebugDto,
  PodContainerStateDto,
  PodDebugInfoDto,
  PodEnvVarDto,
  PodProbeDto,
  PodVolumeDto,
} from '../dto/pod-debug.dto';
import { K8sEventSummary } from '../interfaces/crash-diagnosis.interface';

@Injectable()
export class PodDebugService {
  private readonly logger = new Logger(PodDebugService.name);

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly applicationRepo: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly crashDiagnosesRepository: CrashDiagnosesRepository,
  ) {}

  async getPodDebugInfo(
    applicationId: string,
    podName: string,
  ): Promise<PodDebugInfoDto> {
    const { kubeconfig, app } = await this.loadAppContext(applicationId);

    const pod = await this.kubernetesService.readPod(
      kubeconfig,
      app.k8sNamespace,
      podName,
    );
    if (!pod) {
      throw new NotFoundException(
        `Pod ${podName} not found in namespace ${app.k8sNamespace}`,
      );
    }

    return this.buildDebugInfo(kubeconfig, app, pod);
  }

  async getPodsDebugInfo(applicationId: string): Promise<PodDebugInfoDto[]> {
    const { kubeconfig, app } = await this.loadAppContext(applicationId);

    const selector = `flui-app-id=${app.id}`;
    let pods = await this.kubernetesService.listPodsByLabel(
      kubeconfig,
      app.k8sNamespace,
      selector,
    );

    if (pods.length === 0) {
      pods = await this.kubernetesService.listPodsByLabel(
        kubeconfig,
        app.k8sNamespace,
        `app.kubernetes.io/name=${app.slug}`,
      );
    }

    return Promise.all(
      pods.map((pod) => this.buildDebugInfo(kubeconfig, app, pod)),
    );
  }

  private async loadAppContext(
    applicationId: string,
  ): Promise<{ app: ApplicationEntity; kubeconfig: string }> {
    const app = await this.applicationRepo.findOne({
      where: { id: applicationId },
    });
    if (!app) {
      throw new NotFoundException(`Application ${applicationId} not found`);
    }

    const cluster = await this.clusterRepo.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new NotFoundException(`Cluster ${app.clusterId} has no kubeconfig`);
    }

    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );
    return { app, kubeconfig };
  }

  private async buildDebugInfo(
    kubeconfig: string,
    app: ApplicationEntity,
    pod: k8s.V1Pod,
  ): Promise<PodDebugInfoDto> {
    const namespace = pod.metadata?.namespace ?? app.k8sNamespace;
    const podName = pod.metadata?.name ?? '';

    const [events, containers, volumes, latestDiagnosis] = await Promise.all([
      this.buildEvents(kubeconfig, namespace, podName),
      this.buildContainers(kubeconfig, namespace, pod),
      this.buildVolumes(kubeconfig, namespace, pod),
      this.crashDiagnosesRepository.findLatestForPod(app.id, podName),
    ]);

    return {
      name: podName,
      namespace,
      uid: pod.metadata?.uid ?? '',
      creationTimestamp:
        pod.metadata?.creationTimestamp instanceof Date
          ? pod.metadata.creationTimestamp.toISOString()
          : ((pod.metadata?.creationTimestamp as string | undefined) ?? null),
      labels: pod.metadata?.labels ?? {},
      annotations: pod.metadata?.annotations ?? {},
      nodeName: pod.spec?.nodeName ?? null,
      hostIP: pod.status?.hostIP ?? null,
      podIP: pod.status?.podIP ?? null,
      phase: pod.status?.phase ?? 'Unknown',
      qosClass: pod.status?.qosClass ?? null,
      conditions: (pod.status?.conditions ?? []).map((c) => ({
        type: c.type ?? '',
        status: c.status ?? '',
        reason: c.reason,
        message: c.message,
        lastTransitionTime:
          c.lastTransitionTime instanceof Date
            ? c.lastTransitionTime.toISOString()
            : (c.lastTransitionTime as string | undefined),
      })),
      containers,
      volumes,
      events,
      scheduling: {
        nodeSelector: pod.spec?.nodeSelector,
        tolerations: pod.spec?.tolerations as Array<Record<string, unknown>>,
        affinity: pod.spec?.affinity as unknown as Record<string, unknown>,
      },
      latestDiagnosisId: latestDiagnosis?.id ?? null,
    };
  }

  private async buildEvents(
    kubeconfig: string,
    namespace: string,
    podName: string,
  ): Promise<K8sEventSummary[]> {
    const events = await this.kubernetesService.listEventsFor(
      kubeconfig,
      namespace,
      podName,
    );

    const sorted = [...events].sort((a, b) => {
      const ta = this.timestampToMs(a.lastTimestamp ?? a.eventTime);
      const tb = this.timestampToMs(b.lastTimestamp ?? b.eventTime);
      return tb - ta;
    });

    return sorted.map((e) => ({
      type: e.type ?? '',
      reason: e.reason ?? '',
      message: e.message ?? '',
      count: e.count ?? 1,
      firstTimestamp: this.toIsoString(e.firstTimestamp ?? e.eventTime),
      lastTimestamp: this.toIsoString(e.lastTimestamp ?? e.eventTime),
    }));
  }

  private async buildContainers(
    kubeconfig: string,
    namespace: string,
    pod: k8s.V1Pod,
  ): Promise<PodContainerDebugDto[]> {
    const specContainers = pod.spec?.containers ?? [];
    const statusByName = new Map<string, k8s.V1ContainerStatus>();
    for (const cs of pod.status?.containerStatuses ?? []) {
      if (cs.name) statusByName.set(cs.name, cs);
    }

    return Promise.all(
      specContainers.map(async (c) => {
        const status = statusByName.get(c.name);
        return {
          name: c.name,
          image: c.image ?? '',
          ready: status?.ready ?? false,
          restartCount: status?.restartCount ?? 0,
          requests: {
            cpu: c.resources?.requests?.['cpu'] ?? null,
            memory: c.resources?.requests?.['memory'] ?? null,
          },
          limits: {
            cpu: c.resources?.limits?.['cpu'] ?? null,
            memory: c.resources?.limits?.['memory'] ?? null,
          },
          state: this.mapContainerState(status?.state),
          lastState: status?.lastState
            ? this.mapContainerState(status.lastState)
            : null,
          readinessProbe: this.mapProbe(c.readinessProbe),
          livenessProbe: this.mapProbe(c.livenessProbe),
          startupProbe: this.mapProbe(c.startupProbe),
          env: await this.buildEnv(kubeconfig, namespace, c.env ?? []),
        };
      }),
    );
  }

  private mapContainerState(
    state?: k8s.V1ContainerState,
  ): PodContainerStateDto {
    if (!state) return {};
    return {
      running: state.running
        ? { startedAt: this.toIsoString(state.running.startedAt) }
        : undefined,
      waiting: state.waiting
        ? { reason: state.waiting.reason, message: state.waiting.message }
        : undefined,
      terminated: state.terminated
        ? {
            reason: state.terminated.reason,
            exitCode: state.terminated.exitCode,
            message: state.terminated.message,
            startedAt: this.toIsoString(state.terminated.startedAt),
            finishedAt: this.toIsoString(state.terminated.finishedAt),
          }
        : undefined,
    };
  }

  private mapProbe(probe?: k8s.V1Probe): PodProbeDto | undefined {
    if (!probe) return undefined;
    const common = {
      initialDelaySeconds: probe.initialDelaySeconds,
      periodSeconds: probe.periodSeconds,
      timeoutSeconds: probe.timeoutSeconds,
      failureThreshold: probe.failureThreshold,
      successThreshold: probe.successThreshold,
    };
    if (probe.httpGet) {
      return {
        type: 'http',
        path: probe.httpGet.path,
        port: probe.httpGet.port as number | string,
        ...common,
      };
    }
    if (probe.tcpSocket) {
      return {
        type: 'tcp',
        port: probe.tcpSocket.port as number | string,
        ...common,
      };
    }
    if (probe.exec) {
      return {
        type: 'exec',
        command: probe.exec.command,
        ...common,
      };
    }
    return { type: null, ...common };
  }

  private async buildEnv(
    kubeconfig: string,
    namespace: string,
    env: k8s.V1EnvVar[],
  ): Promise<PodEnvVarDto[]> {
    return Promise.all(
      env.map(async (e): Promise<PodEnvVarDto> => {
        if (e.valueFrom?.secretKeyRef?.name) {
          const ref = e.valueFrom.secretKeyRef;
          const exists = await this.kubernetesService.checkSecretExists(
            kubeconfig,
            namespace,
            ref.name,
          );
          return {
            name: e.name,
            valueFrom: {
              kind: 'Secret',
              name: ref.name,
              key: ref.key ?? '',
              exists,
            },
          };
        }
        if (e.valueFrom?.configMapKeyRef?.name) {
          const ref = e.valueFrom.configMapKeyRef;
          const exists = await this.kubernetesService.checkConfigMapExists(
            kubeconfig,
            namespace,
            ref.name,
          );
          return {
            name: e.name,
            valueFrom: {
              kind: 'ConfigMap',
              name: ref.name,
              key: ref.key ?? '',
              exists,
            },
          };
        }
        return { name: e.name, value: e.value };
      }),
    );
  }

  private async buildVolumes(
    kubeconfig: string,
    namespace: string,
    pod: k8s.V1Pod,
  ): Promise<PodVolumeDto[]> {
    const volumes = pod.spec?.volumes ?? [];
    return Promise.all(
      volumes.map(async (v): Promise<PodVolumeDto> => {
        if (v.secret?.secretName) {
          const exists = await this.kubernetesService.checkSecretExists(
            kubeconfig,
            namespace,
            v.secret.secretName,
          );
          return {
            name: v.name,
            kind: 'Secret',
            resourceName: v.secret.secretName,
            exists,
          };
        }
        if (v.configMap?.name) {
          const exists = await this.kubernetesService.checkConfigMapExists(
            kubeconfig,
            namespace,
            v.configMap.name,
          );
          return {
            name: v.name,
            kind: 'ConfigMap',
            resourceName: v.configMap.name,
            exists,
          };
        }
        if (v.persistentVolumeClaim?.claimName) {
          return {
            name: v.name,
            kind: 'PersistentVolumeClaim',
            resourceName: v.persistentVolumeClaim.claimName,
          };
        }
        if (v.emptyDir) {
          return { name: v.name, kind: 'EmptyDir' };
        }
        return { name: v.name, kind: 'Other' };
      }),
    );
  }

  private toIsoString(value: unknown): string | undefined {
    if (!value) return undefined;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    return undefined;
  }

  private timestampToMs(value: unknown): number {
    if (!value) return 0;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string') {
      const t = new Date(value).getTime();
      return Number.isFinite(t) ? t : 0;
    }
    return 0;
  }
}
