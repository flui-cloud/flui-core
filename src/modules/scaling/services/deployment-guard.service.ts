import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as k8s from '@kubernetes/client-node';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEventsGateway } from '../../applications/gateway/application-events.gateway';
import {
  DiagnosticEngineService,
  Diagnosis,
} from './diagnostic-engine.service';
import { CrashRecoveryService } from './crash-recovery.service';
import { CrashDiagnosesRepository } from '../repositories/crash-diagnoses.repository';
import { CrashDiagnosisEntity } from '../entities/crash-diagnosis.entity';
import { DiagnosisSeverity } from '../enums/diagnosis-severity.enum';

interface GuardHandle {
  controller: AbortController;
  timer: NodeJS.Timeout;
  diagnosedPods: Set<string>;
}

export interface DeploymentGuardOptions {
  durationMs?: number;
}

const DEFAULT_DURATION_MS = 120_000;

@Injectable()
export class DeploymentGuardService {
  private readonly logger = new Logger(DeploymentGuardService.name);
  private readonly activeGuards = new Map<string, GuardHandle>();

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly diagnosticEngine: DiagnosticEngineService,
    private readonly crashDiagnosesRepository: CrashDiagnosesRepository,
    private readonly eventsGateway: ApplicationEventsGateway,
    private readonly crashRecoveryService: CrashRecoveryService,
  ) {}

  async open(
    app: ApplicationEntity,
    options: DeploymentGuardOptions = {},
  ): Promise<void> {
    const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;

    this.close(app.id);

    const cluster = await this.clusterRepo.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      this.logger.warn(
        `Cannot open guard for app ${app.id}: cluster has no kubeconfig`,
      );
      return;
    }

    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );

    const controller = new AbortController();
    const diagnosedPods = new Set<string>();

    const timer = setTimeout(() => {
      this.logger.debug(
        `Deployment guard for app ${app.id} closed after ${durationMs}ms (stable)`,
      );
      this.close(app.id);
    }, durationMs);

    const handle: GuardHandle = { controller, timer, diagnosedPods };
    this.activeGuards.set(app.id, handle);

    this.logger.log(
      `Deployment guard opened for app ${app.slug} (${app.id}) for ${durationMs}ms`,
    );

    try {
      await this.kubernetesService.watchPodEvents(
        kubeconfig,
        app.k8sNamespace,
        `flui-app-id=${app.id}`,
        (type, pod) => this.onPodEvent(app, kubeconfig, handle, type, pod),
        controller,
      );
    } catch (err) {
      this.logger.warn(
        `Deployment guard failed to start watch for app ${app.id}: ${(err as Error).message}`,
      );
      this.close(app.id);
    }
  }

  close(appId: string): void {
    const handle = this.activeGuards.get(appId);
    if (!handle) return;
    clearTimeout(handle.timer);
    try {
      handle.controller.abort();
    } catch {
      /* noop */
    }
    this.activeGuards.delete(appId);
  }

  private async onPodEvent(
    app: ApplicationEntity,
    kubeconfig: string,
    handle: GuardHandle,
    type: string,
    pod: k8s.V1Pod,
  ): Promise<void> {
    if (type === 'DELETED') return;
    const podName = pod.metadata?.name;
    if (!podName) return;

    if (handle.diagnosedPods.has(podName)) return;

    try {
      const diagnosis = await this.diagnosticEngine.analyze({
        app,
        kubeconfig,
        pod,
      });
      if (!diagnosis) return;

      handle.diagnosedPods.add(podName);
      const entity = await this.persistDiagnosis(app.id, diagnosis);
      this.eventsGateway.emitCrashDiagnosis(app.id, entity);
      void this.crashRecoveryService
        .ensureWatching(app)
        .catch((err) =>
          this.logger.warn(
            `Crash recovery watch failed for ${app.slug}: ${(err as Error).message}`,
          ),
        );

      if (diagnosis.severity === DiagnosisSeverity.CRITICAL) {
        this.close(app.id);
      }
    } catch (err) {
      this.logger.error(
        `Deployment guard failed to process pod event for ${podName}: ${(err as Error).message}`,
      );
    }
  }

  private persistDiagnosis(
    applicationId: string,
    diagnosis: Diagnosis,
  ): Promise<CrashDiagnosisEntity> {
    return this.crashDiagnosesRepository.create({
      applicationId,
      podName: diagnosis.podName,
      containerName: diagnosis.containerName,
      category: diagnosis.category,
      severity: diagnosis.severity,
      title: diagnosis.title,
      explanation: diagnosis.explanation,
      evidence: diagnosis.evidence,
      patternMatchedKey: diagnosis.patternMatchedKey,
      suggestedAction: diagnosis.suggestedAction,
      podSnapshot: diagnosis.podSnapshot,
    });
  }
}
