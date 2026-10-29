import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  REPLICATED_STORAGE_NODE_LABEL,
  REPLICATED_VOLUMES_JOB_NAMESPACE,
} from '../replicated-volumes.constants';
import {
  ReplicatedPoolState,
  parseReplicatedPoolOutput,
  replicatedPoolHostScript,
} from '../utils/replicated-volumes.core';

const JOB_TIMEOUT_MS = 15 * 60 * 1000;
const JOB_POLL_MS = 3000;
const JOB_LABEL = 'flui-replicated-pool-job';

/**
 * Prepares the nodes that will hold copies, through a privileged job on each
 * one, and marks a node only once its pool is there: the engine puts data
 * only on marked nodes. Running it again on a prepared node changes nothing.
 */
@Injectable()
export class ReplicatedPoolPreparer {
  constructor(private readonly kubernetes: KubernetesService) {}

  async prepare(
    kubeconfig: string,
    node: string,
    sizeGiB: number,
  ): Promise<ReplicatedPoolState> {
    const state = parseReplicatedPoolOutput(
      await this.runHostScript(
        kubeconfig,
        node,
        replicatedPoolHostScript(sizeGiB),
      ),
    );
    if (state.kind === 'ready') {
      await this.kubernetes.addNodeLabels(kubeconfig, node, {
        [REPLICATED_STORAGE_NODE_LABEL]: 'true',
      });
    }
    return state;
  }

  /** Runs a script on the node itself, through the same privileged job, and returns what it printed. */
  async runHostScript(
    kubeconfig: string,
    node: string,
    hostScript: string,
  ): Promise<string> {
    const jobName = `flui-replicated-pool-${Date.now()}-${randomUUID().slice(0, 5)}`;
    await this.kubernetes.applyManifest(
      kubeconfig,
      hostScriptJobManifest(jobName, node, hostScript),
    );
    try {
      await this.awaitJob(kubeconfig, jobName);
      return await this.readJobLogs(kubeconfig, jobName);
    } finally {
      await this.kubernetes
        .deleteResource(
          kubeconfig,
          'Job',
          jobName,
          REPLICATED_VOLUMES_JOB_NAMESPACE,
        )
        .catch(() => undefined);
    }
  }

  private async awaitJob(kubeconfig: string, jobName: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < JOB_TIMEOUT_MS) {
      const job = await this.kubernetes.getResource(
        kubeconfig,
        'Job',
        jobName,
        REPLICATED_VOLUMES_JOB_NAMESPACE,
      );
      if ((job?.status?.succeeded ?? 0) > 0) return;
      if ((job?.status?.failed ?? 0) > 0) {
        throw new Error(`replicated pool job ${jobName} failed`);
      }
      await new Promise((r) => setTimeout(r, JOB_POLL_MS));
    }
    throw new Error(`replicated pool job ${jobName} timed out`);
  }

  private async readJobLogs(
    kubeconfig: string,
    jobName: string,
  ): Promise<string> {
    const coreApi = this.kubernetes
      .makeKubeConfig(kubeconfig)
      .makeApiClient(k8s.CoreV1Api);
    const pods = await coreApi.listNamespacedPod({
      namespace: REPLICATED_VOLUMES_JOB_NAMESPACE,
      labelSelector: `${JOB_LABEL}=${jobName}`,
    });
    const podName = pods.items?.[0]?.metadata?.name;
    if (!podName) throw new Error(`no pod found for job ${jobName}`);
    return this.kubernetes.getPodLogs(
      kubeconfig,
      podName,
      REPLICATED_VOLUMES_JOB_NAMESPACE,
    );
  }
}

export function replicatedPoolJobManifest(
  jobName: string,
  node: string,
  sizeGiB: number,
): string {
  return hostScriptJobManifest(
    jobName,
    node,
    replicatedPoolHostScript(sizeGiB),
  );
}

export function hostScriptJobManifest(
  jobName: string,
  node: string,
  hostScript: string,
): string {
  const script = [
    'apk add --no-cache util-linux >/dev/null 2>&1 || true',
    "SCRIPT=$(cat <<'FLUIPOOL'",
    hostScript,
    'FLUIPOOL',
    ')',
    'nsenter -t 1 -m -u -i -n -p -- /bin/sh -c "$SCRIPT"',
  ]
    .join('\n')
    .split('\n')
    .map((line) => `            ${line}`)
    .join('\n');
  return [
    'apiVersion: batch/v1',
    'kind: Job',
    'metadata:',
    `  name: ${jobName}`,
    `  namespace: ${REPLICATED_VOLUMES_JOB_NAMESPACE}`,
    '  labels:',
    '    flui.cloud/managed-by: flui-cloud',
    '    flui-resource-type: replicated-pool',
    'spec:',
    '  ttlSecondsAfterFinished: 60',
    '  backoffLimit: 0',
    '  template:',
    '    metadata:',
    '      labels:',
    '        flui.cloud/managed-by: flui-cloud',
    '        flui-resource-type: replicated-pool',
    `        ${JOB_LABEL}: ${jobName}`,
    '    spec:',
    '      restartPolicy: Never',
    '      hostPID: true',
    '      nodeSelector:',
    `        kubernetes.io/hostname: ${node}`,
    '      tolerations:',
    '      - operator: Exists',
    '      containers:',
    '      - name: replicated-pool',
    '        image: alpine:3.20',
    '        securityContext:',
    '          privileged: true',
    '        command: ["sh","-c"]',
    '        args:',
    '        - |',
    script,
    '',
  ].join('\n');
}
