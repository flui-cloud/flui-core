import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { CrashPatternMatcherService } from './crash-pattern-matcher.service';
import { CrashCategory } from '../enums/crash-category.enum';
import { DiagnosisSeverity } from '../enums/diagnosis-severity.enum';
import { SuggestedActionType } from '../enums/suggested-action-type.enum';
import {
  CrashEvidence,
  K8sEventSummary,
  SuggestedAction,
} from '../interfaces/crash-diagnosis.interface';

export interface DiagnosticInput {
  pod: k8s.V1Pod;
  app: ApplicationEntity;
  kubeconfig: string;
}

type PartialDiagnosis = Omit<
  Diagnosis,
  'podName' | 'containerName' | 'podSnapshot'
>;

export interface Diagnosis {
  podName: string;
  containerName: string | null;
  category: CrashCategory;
  severity: DiagnosisSeverity;
  title: string;
  explanation: string;
  evidence: CrashEvidence;
  patternMatchedKey: string | null;
  suggestedAction: SuggestedAction;
  podSnapshot: Record<string, unknown>;
}

@Injectable()
export class DiagnosticEngineService {
  private readonly logger = new Logger(DiagnosticEngineService.name);

  constructor(
    private readonly kubernetesService: KubernetesService,
    private readonly patternMatcher: CrashPatternMatcherService,
  ) {}

  async analyze(input: DiagnosticInput): Promise<Diagnosis | null> {
    const { pod } = input;
    const podName = pod.metadata?.name ?? 'unknown';

    // A pod with a deletionTimestamp is being drained, typically the previous
    // revision during a rollout. Its death is expected, not a crash.
    if (pod.metadata?.deletionTimestamp) return null;

    const unschedulable = this.checkUnschedulable(pod);
    if (unschedulable) {
      return this.finalize(podName, null, unschedulable, pod);
    }

    const containerStatuses = pod.status?.containerStatuses ?? [];
    for (const cs of containerStatuses) {
      const oom = this.checkOomKilled(cs);
      if (oom) return this.finalize(podName, cs.name, oom, pod);

      const configError = this.checkCreateContainerConfigError(cs);
      if (configError) return this.finalize(podName, cs.name, configError, pod);

      const imagePull = this.checkImagePullError(cs);
      if (imagePull) return this.finalize(podName, cs.name, imagePull, pod);

      const probeFailure = await this.checkProbeFailure(input, cs);
      if (probeFailure)
        return this.finalize(podName, cs.name, probeFailure, pod);

      const crashLoop = await this.checkCrashLoop(input, cs);
      if (crashLoop) return this.finalize(podName, cs.name, crashLoop, pod);
    }

    return null;
  }

  private checkUnschedulable(pod: k8s.V1Pod): PartialDiagnosis | null {
    const scheduled = pod.status?.conditions?.find(
      (c) => c.type === 'PodScheduled',
    );
    if (scheduled?.status === 'False' && scheduled.reason === 'Unschedulable') {
      return {
        category: CrashCategory.UNSCHEDULABLE,
        severity: DiagnosisSeverity.CRITICAL,
        title: 'Cluster has no available capacity',
        explanation: `The pod cannot be scheduled: ${scheduled.message ?? 'no resources available'}.`,
        evidence: {
          events: [
            {
              type: 'Warning',
              reason: 'Unschedulable',
              message: scheduled.message ?? '',
              count: 1,
            },
          ],
        },
        patternMatchedKey: null,
        suggestedAction: {
          type: SuggestedActionType.MANUAL,
          message:
            'Add a node to the cluster or reduce the resources requested by the application.',
        },
      };
    }
    return null;
  }

  private checkOomKilled(cs: k8s.V1ContainerStatus): PartialDiagnosis | null {
    const terminated = cs.state?.terminated ?? null;
    // Only the kernel's own verdict counts. Exit code 137 alone is any SIGKILL
    // (most often a container that outlived its termination grace period during
    // a rollout) and misreading it as OOM makes the actuator inflate memory.
    if (terminated?.reason !== 'OOMKilled') return null;

    return {
      category: CrashCategory.OOM_KILLED,
      severity: DiagnosisSeverity.CRITICAL,
      title: 'Application killed due to out of memory',
      explanation:
        'The container exceeded its configured memory limit and was terminated by the kernel. The memory limit is likely too low for the current workload.',
      evidence: {
        exitCode: terminated.exitCode,
        lastTerminationReason: terminated.reason,
      },
      patternMatchedKey: null,
      suggestedAction: {
        type: SuggestedActionType.MANUAL,
        message:
          'Increase the application memory limit. Automatic fix will be available in a future release.',
      },
    };
  }

  private checkCreateContainerConfigError(
    cs: k8s.V1ContainerStatus,
  ): PartialDiagnosis | null {
    const waiting = cs.state?.waiting;
    if (!waiting) return null;

    const configErrors = [
      'CreateContainerConfigError',
      'CreateContainerError',
      'InvalidImageName',
    ];
    if (!waiting.reason || !configErrors.includes(waiting.reason)) return null;

    const message = waiting.message ?? '';
    const secretMatch = /secret\s+["']?([^"'\s]+)["']?\s+not\s+found/i.exec(
      message,
    );
    const configMapMatch =
      /configmap\s+["']?([^"'\s]+)["']?\s+not\s+found/i.exec(message);

    const evidence: CrashEvidence = {
      lastTerminationReason: waiting.reason,
      events: [
        {
          type: 'Warning',
          reason: waiting.reason,
          message,
          count: 1,
        },
      ],
    };
    if (secretMatch) {
      evidence.missingResource = { kind: 'Secret', name: secretMatch[1] };
    } else if (configMapMatch) {
      evidence.missingResource = {
        kind: 'ConfigMap',
        name: configMapMatch[1],
      };
    }

    const resourceName = evidence.missingResource?.name;
    const resourceKind = evidence.missingResource?.kind;

    return {
      category: CrashCategory.CONFIG_ERROR,
      severity: DiagnosisSeverity.CRITICAL,
      title: resourceName
        ? `${resourceKind} ${resourceName} not found`
        : 'Container configuration error',
      explanation: resourceName
        ? `The container cannot start because it references ${resourceKind} "${resourceName}" which does not exist in the namespace.`
        : `The container cannot start due to a configuration error: ${message}`,
      evidence,
      patternMatchedKey: null,
      suggestedAction: {
        type: SuggestedActionType.USER_INPUT,
        message: resourceName
          ? `Create the ${resourceKind} "${resourceName}" or remove the reference from the application configuration.`
          : 'Review environment variables and volume configuration.',
        payload: evidence.missingResource
          ? { ...evidence.missingResource }
          : {},
      },
    };
  }

  private checkImagePullError(
    cs: k8s.V1ContainerStatus,
  ): PartialDiagnosis | null {
    const waiting = cs.state?.waiting;
    if (!waiting) return null;

    const pullErrors = ['ImagePullBackOff', 'ErrImagePull', 'InvalidImageName'];
    if (!waiting.reason || !pullErrors.includes(waiting.reason)) return null;

    return {
      category: CrashCategory.IMAGE_PULL_ERROR,
      severity: DiagnosisSeverity.CRITICAL,
      title: 'Cannot pull container image',
      explanation:
        'Kubernetes cannot pull the image. Possible causes: image does not exist, missing or invalid registry credentials, network issue.',
      evidence: {
        lastTerminationReason: waiting.reason,
        events: [
          {
            type: 'Warning',
            reason: waiting.reason,
            message: waiting.message ?? '',
            count: 1,
          },
        ],
      },
      patternMatchedKey: null,
      suggestedAction: {
        type: SuggestedActionType.USER_INPUT,
        message: 'Check the image name and registry configuration.',
      },
    };
  }

  private async checkProbeFailure(
    input: DiagnosticInput,
    cs: k8s.V1ContainerStatus,
  ): Promise<Omit<
    Diagnosis,
    'podName' | 'containerName' | 'podSnapshot'
  > | null> {
    if (!cs.state?.running && (cs.restartCount ?? 0) === 0) return null;

    const events = await this.kubernetesService.listPodEvents(
      input.kubeconfig,
      input.pod.metadata?.namespace ?? 'default',
      input.pod.metadata?.name ?? '',
    );

    const unhealthy = events.find(
      (e) => e.reason === 'Unhealthy' && e.type === 'Warning',
    );
    if (!unhealthy) return null;

    const message = unhealthy.message ?? '';
    const isLiveness = /liveness/i.test(message);
    const isReadiness = /readiness/i.test(message);

    const summaries: K8sEventSummary[] = events
      .filter((e) => e.reason === 'Unhealthy')
      .map((e) => ({
        type: e.type ?? '',
        reason: e.reason ?? '',
        message: e.message ?? '',
        count: e.count ?? 1,
      }));

    let title: string;
    if (isLiveness) title = 'Liveness probe failing';
    else if (isReadiness) title = 'Readiness probe failing';
    else title = 'Health probe failing';

    return {
      category: CrashCategory.PROBE_FAILURE,
      severity: DiagnosisSeverity.WARNING,
      title,
      explanation:
        'The application started but is not responding to health checks correctly. It may still be starting up or not listening on the configured port.',
      evidence: { events: summaries },
      patternMatchedKey: null,
      suggestedAction: {
        type: SuggestedActionType.MANUAL,
        message:
          'Verify the application listens on the declared port and the probe endpoint is correct. Consider increasing initialDelaySeconds if startup is slow.',
      },
    };
  }

  private async checkCrashLoop(
    input: DiagnosticInput,
    cs: k8s.V1ContainerStatus,
  ): Promise<Omit<
    Diagnosis,
    'podName' | 'containerName' | 'podSnapshot'
  > | null> {
    const waiting = cs.state?.waiting;
    const inCrashLoop = waiting?.reason === 'CrashLoopBackOff';
    const repeatedRestarts =
      (cs.restartCount ?? 0) >= 2 && cs.lastState?.terminated;

    if (!inCrashLoop && !repeatedRestarts) return null;

    let logs = '';
    try {
      logs = await this.kubernetesService.getPodLogs(
        input.kubeconfig,
        input.pod.metadata?.name ?? '',
        input.pod.metadata?.namespace ?? 'default',
        cs.name,
        200,
      );
    } catch (err) {
      this.logger.debug(
        `Could not fetch logs for crash loop diagnosis: ${(err as Error).message}`,
      );
    }

    const match = logs ? this.patternMatcher.match(logs) : null;
    if (match) {
      const { pattern, diagnosis } = match;
      return {
        category: pattern.category,
        severity: diagnosis.severity,
        title: diagnosis.title,
        explanation: diagnosis.explanation,
        evidence: diagnosis.evidence,
        patternMatchedKey: pattern.key,
        suggestedAction: diagnosis.suggestedAction,
      };
    }

    const tail = logs.slice(-400);
    return {
      category: CrashCategory.CRASH_LOOP,
      severity: DiagnosisSeverity.WARNING,
      title: 'Container in crash loop',
      explanation:
        'The container keeps restarting and Flui did not recognize a known pattern in the logs. Check the raw logs in the debug section.',
      evidence: {
        logsSnippet: tail || undefined,
        lastTerminationReason: cs.lastState?.terminated?.reason,
        exitCode: cs.lastState?.terminated?.exitCode,
      },
      patternMatchedKey: null,
      suggestedAction: {
        type: SuggestedActionType.MANUAL,
        message:
          'Inspect the application logs in the debug section to identify the root cause.',
      },
    };
  }

  private finalize(
    podName: string,
    containerName: string | null,
    partial: PartialDiagnosis,
    pod: k8s.V1Pod,
  ): Diagnosis {
    return {
      podName,
      containerName,
      ...partial,
      podSnapshot: pod as unknown as Record<string, unknown>,
    };
  }
}
