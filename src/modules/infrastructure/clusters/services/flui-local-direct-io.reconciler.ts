import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as k8s from '@kubernetes/client-node';
import { ClusterEntity } from '../entities/cluster.entity';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';

const FLUI_LOCAL_PATH = '/var/lib/flui/local';
const JOB_NAMESPACE = 'flui-local-storage';
const JOB_TIMEOUT_MS = 180_000;
const JOB_POLL_MS = 2_000;
export const DIRECT_IO_ANNOTATION = 'flui.cloud/local-direct-io';

export type DirectIoState =
  | { kind: 'on'; device: string }
  | { kind: 'not-a-loop'; source: string }
  | { kind: 'off'; device: string }
  | { kind: 'unknown'; detail: string };

export interface NodeDirectIoResult {
  node: string;
  state: DirectIoState;
}

/**
 * The same helper and unit the bootstrap scripts install, so a node fixed here
 * ends up exactly like one that booted with them. Runs in the host's mount
 * namespace, where `findmnt` sees the loop device and not a bind mount.
 */
export function directIoHostScript(): string {
  return [
    'set -e',
    `ROOT=${FLUI_LOCAL_PATH}`,
    'DEV=$(findmnt -n -o SOURCE "$ROOT" 2>/dev/null || true)',
    'case "$DEV" in /dev/loop*) ;; *) echo "NOTLOOP ${DEV:-none}"; exit 0 ;; esac',
    "cat > /usr/local/sbin/flui-local-direct-io <<'FLUIHELPER'",
    '#!/bin/sh',
    `dev=$(findmnt -n -o SOURCE "${FLUI_LOCAL_PATH}" 2>/dev/null)`,
    'case "$dev" in /dev/loop*) exec losetup --direct-io=on "$dev" ;; esac',
    'FLUIHELPER',
    'chmod 755 /usr/local/sbin/flui-local-direct-io',
    "cat > /etc/systemd/system/flui-local-direct-io.service <<'FLUIUNIT'",
    '[Unit]',
    'Description=Direct I/O for the flui-local loop device',
    `RequiresMountsFor=${FLUI_LOCAL_PATH}`,
    '',
    '[Service]',
    'Type=oneshot',
    'ExecStart=/usr/local/sbin/flui-local-direct-io',
    'RemainAfterExit=yes',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'FLUIUNIT',
    'systemctl daemon-reload >/dev/null 2>&1 || true',
    'systemctl enable flui-local-direct-io.service >/dev/null 2>&1 || true',
    '/usr/local/sbin/flui-local-direct-io',
    'echo "DIO $DEV $(cat /sys/block/${DEV#/dev/}/loop/dio)"',
  ].join('\n');
}

export function parseDirectIoOutput(logs: string): DirectIoState {
  for (const raw of logs.split('\n')) {
    const line = raw.trim();
    const notLoop = /^NOTLOOP (.+)$/.exec(line);
    if (notLoop) return { kind: 'not-a-loop', source: notLoop[1] };
    const dio = /^DIO (\/dev\/loop\d+) ([01])$/.exec(line);
    if (dio) {
      return dio[2] === '1'
        ? { kind: 'on', device: dio[1] }
        : { kind: 'off', device: dio[1] };
    }
  }
  return { kind: 'unknown', detail: logs.trim().slice(-200) };
}

/**
 * Turns direct I/O on for the `flui-local` loop of nodes that booted before
 * the bootstrap scripts did it. Without it every write crosses the host's page
 * cache a second time and sequential writes stall for over a second; on a
 * mounted loop the change takes effect at once, with nothing to move.
 *
 * A node is marked once it is settled, so each node runs the job once.
 */
@Injectable()
export class FluiLocalDirectIoReconciler {
  private readonly logger = new Logger(FluiLocalDirectIoReconciler.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
  ) {}

  async reconcile(clusterId: string): Promise<NodeDirectIoResult[]> {
    const cluster = await this.clusters.findOne({ where: { id: clusterId } });
    if (!cluster?.kubeconfigEncrypted) return [];
    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);

    const annotations = await this.kubernetes.listNodeAnnotations(kubeconfig);
    const results: NodeDirectIoResult[] = [];
    for (const [node, current] of annotations) {
      if (current[DIRECT_IO_ANNOTATION]) continue;
      let state: DirectIoState;
      try {
        state = parseDirectIoOutput(await this.runOnNode(kubeconfig, node));
      } catch (error) {
        state = { kind: 'unknown', detail: (error as Error).message };
      }
      results.push({ node, state });
      if (state.kind === 'on' || state.kind === 'not-a-loop') {
        await this.kubernetes.addNodeAnnotations(kubeconfig, node, {
          [DIRECT_IO_ANNOTATION]: state.kind,
        });
      } else {
        const detail =
          state.kind === 'off'
            ? `${state.device} still without direct I/O`
            : state.detail;
        this.logger.warn(
          `[local-direct-io] ${cluster.name}/${node}: ${detail}`,
        );
      }
    }
    const changed = results.filter((r) => r.state.kind === 'on');
    if (changed.length) {
      this.logger.log(
        `[local-direct-io] ${cluster.name}: direct I/O on ${changed.map((r) => r.node).join(', ')}`,
      );
    }
    return results;
  }

  private async runOnNode(kubeconfig: string, node: string): Promise<string> {
    const jobName = `flui-local-direct-io-${Date.now()}-${randomUUID().slice(0, 5)}`;
    await this.kubernetes.applyManifest(
      kubeconfig,
      directIoJobManifest(jobName, node),
    );
    try {
      await this.awaitJob(kubeconfig, jobName);
      return await this.readJobLogs(kubeconfig, jobName);
    } finally {
      await this.kubernetes
        .deleteResource(kubeconfig, 'Job', jobName, JOB_NAMESPACE)
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
        JOB_NAMESPACE,
      );
      if ((job?.status?.succeeded ?? 0) > 0) return;
      if ((job?.status?.failed ?? 0) > 0) {
        throw new Error(`direct I/O job ${jobName} failed`);
      }
      await new Promise((r) => setTimeout(r, JOB_POLL_MS));
    }
    throw new Error(`direct I/O job ${jobName} timed out`);
  }

  private async readJobLogs(
    kubeconfig: string,
    jobName: string,
  ): Promise<string> {
    const coreApi = this.kubernetes
      .makeKubeConfig(kubeconfig)
      .makeApiClient(k8s.CoreV1Api);
    const pods = await coreApi.listNamespacedPod({
      namespace: JOB_NAMESPACE,
      labelSelector: `flui-local-direct-io-job=${jobName}`,
    });
    const podName = pods.items?.[0]?.metadata?.name;
    if (!podName) throw new Error(`no pod found for job ${jobName}`);
    return this.kubernetes.getPodLogs(kubeconfig, podName, JOB_NAMESPACE);
  }
}

export function directIoJobManifest(jobName: string, node: string): string {
  const script = [
    'apk add --no-cache util-linux >/dev/null 2>&1 || true',
    "SCRIPT=$(cat <<'FLUIPROBE'",
    directIoHostScript(),
    'FLUIPROBE',
    ')',
    'nsenter -t 1 -m -- /bin/sh -c "$SCRIPT"',
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
    `  namespace: ${JOB_NAMESPACE}`,
    '  labels:',
    '    flui.cloud/managed-by: flui-cloud',
    '    flui-resource-type: local-direct-io',
    'spec:',
    '  ttlSecondsAfterFinished: 60',
    '  backoffLimit: 0',
    '  template:',
    '    metadata:',
    '      labels:',
    '        flui.cloud/managed-by: flui-cloud',
    '        flui-resource-type: local-direct-io',
    `        flui-local-direct-io-job: ${jobName}`,
    '    spec:',
    '      restartPolicy: Never',
    '      hostPID: true',
    '      nodeSelector:',
    `        kubernetes.io/hostname: ${node}`,
    '      tolerations:',
    '      - operator: Exists',
    '      containers:',
    '      - name: direct-io',
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
