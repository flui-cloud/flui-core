import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as k8s from '@kubernetes/client-node';
import { ClusterEntity } from '../entities/cluster.entity';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { FLUI_SHARED_STORAGE_PATH } from '../constants/storage-conventions';

/** Where `flui-local` keeps a dedicated application's data, on each node's own disk. */
const FLUI_LOCAL_STORAGE_PATH = '/var/lib/flui/local';

/**
 * Where the short-lived probes run.
 *
 * Not `flui-system`, which is the control plane's own and does not exist on a
 * workload cluster — a job placed there is refused with `namespaces
 * "flui-system" not found`, and every node then reports as though its storage
 * could not enforce a quota. This namespace ships in the common manifests, so
 * it exists wherever `flui-local` does, which is exactly where these probes
 * have anything to look at.
 */
const JOB_NAMESPACE = 'flui-local-storage';
const JOB_TIMEOUT_MS = 120_000;
const JOB_POLL_MS = 2_000;

export type StorageRootKind = 'local' | 'shared';

export interface VolumeUsage {
  /** The PersistentVolumeClaim's own name, which is the application's volume. */
  volumeName: string;
  /** The tenancy the volume belongs to — one namespace per user. */
  namespace: string;
  kind: StorageRootKind;
  node: string;
  bytes: number;
}

export interface NamespaceUsage {
  namespace: string;
  bytes: number;
  volumes: number;
}

export interface ClusterStorageUsage {
  measuredAt: string;
  /** Nodes that answered. A node that could not be measured is named in `unreachable`. */
  nodes: string[];
  unreachable: Array<{ node: string; reason: string }>;
  volumes: VolumeUsage[];
  byNamespace: NamespaceUsage[];
  totals: Record<StorageRootKind, number>;
}

/**
 * How much disk each application and each tenancy is really using.
 *
 * Kubernetes cannot answer this. It publishes `kubelet_volume_stats_used_bytes`
 * per claim, but on Flui's local-path classes a volume is a directory on a
 * filesystem shared with everything else, so the kubelet reports *that
 * filesystem*: three volumes of 1Gi, 5Gi and 1Mi all report the same 192.7GiB
 * capacity and 29.6GiB used — the machine's figures, not theirs. Every volume
 * reads as the same percentage, so the metric can neither find the application
 * filling a disk nor prove that one is not.
 *
 * Measuring the directories gives the true number, and the names give the
 * attribution for free: local-path writes `pvc-<uid>_<namespace>_<claim>`, so
 * the tenancy and the volume are in the path and nothing has to be correlated
 * back through the API.
 *
 * Two roots, and both are needed: an application with `persistenceScope:
 * dedicated` — which is what every database in the catalogue declares — keeps
 * its data on the node's own disk, while everything else lands on the shared
 * volume. Measuring only one of them would miss whichever half matters.
 */
@Injectable()
export class ClusterStorageUsageService {
  private readonly logger = new Logger(ClusterStorageUsageService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
  ) {}

  async measure(clusterId: string): Promise<ClusterStorageUsage> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new BadRequestException(`Cluster ${clusterId} not found`);
    }
    if (!cluster.kubeconfigEncrypted) {
      throw new BadRequestException(
        `Cluster ${cluster.id} has no kubeconfig — cannot measure storage`,
      );
    }
    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );

    const nodes = await this.listNodes(kubeconfig);
    const volumes: VolumeUsage[] = [];
    const unreachable: Array<{ node: string; reason: string }> = [];
    const measured: string[] = [];

    // The shared root is one filesystem every node mounts, so it is measured
    // once — on the first node that answers. Measuring it per node would count
    // the same bytes as many times as there are machines.
    let sharedTaken = false;

    for (const node of nodes) {
      try {
        const rows = await this.runProbe(kubeconfig, node, !sharedTaken);
        volumes.push(...rows);
        if (!sharedTaken && rows.some((r) => r.kind === 'shared')) {
          sharedTaken = true;
        }
        measured.push(node);
      } catch (error) {
        unreachable.push({ node, reason: (error as Error).message });
        this.logger.warn(
          `Could not measure storage on ${node}: ${(error as Error).message}`,
        );
      }
    }

    return {
      measuredAt: new Date().toISOString(),
      nodes: measured,
      unreachable,
      volumes: volumes.sort((a, b) => b.bytes - a.bytes),
      byNamespace: this.foldByNamespace(volumes),
      totals: {
        local: this.sum(volumes, 'local'),
        shared: this.sum(volumes, 'shared'),
      },
    };
  }

  private sum(volumes: VolumeUsage[], kind: StorageRootKind): number {
    return volumes
      .filter((v) => v.kind === kind)
      .reduce((n, v) => n + v.bytes, 0);
  }

  private foldByNamespace(volumes: VolumeUsage[]): NamespaceUsage[] {
    const byNs = new Map<string, NamespaceUsage>();
    for (const v of volumes) {
      const row = byNs.get(v.namespace) ?? {
        namespace: v.namespace,
        bytes: 0,
        volumes: 0,
      };
      row.bytes += v.bytes;
      row.volumes += 1;
      byNs.set(v.namespace, row);
    }
    return [...byNs.values()].sort((a, b) => b.bytes - a.bytes);
  }

  private async listNodes(kubeconfig: string): Promise<string[]> {
    const kc = this.kubernetesService.makeKubeConfig(kubeconfig);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const list = await coreApi.listNode();
    return (list.items ?? [])
      .map((n) => n.metadata?.name)
      .filter((n): n is string => Boolean(n));
  }

  /**
   * One short-lived pod per node, reading the two directories.
   *
   * Not privileged: reading a directory needs root, which the container already
   * is, and nothing here writes. `du -sk` rather than `-sb` because the image is
   * busybox-based and only the portable flags can be relied on.
   */
  private async runProbe(
    kubeconfig: string,
    node: string,
    includeShared: boolean,
  ): Promise<VolumeUsage[]> {
    const jobName = `flui-storage-usage-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    const roots = includeShared
      ? `local:${FLUI_LOCAL_STORAGE_PATH} shared:${FLUI_SHARED_STORAGE_PATH}`
      : `local:${FLUI_LOCAL_STORAGE_PATH}`;

    const script =
      `set -e; for pair in ${roots}; do ` +
      `kind=\${pair%%:*}; root=/host/\${kind}; ` +
      `[ -d "$root" ] || continue; ` +
      `for d in "$root"/*; do ` +
      `[ -d "$d" ] || continue; ` +
      `echo "$kind\t$(basename "$d")\t$(du -sk "$d" | cut -f1)"; ` +
      `done; done`;

    const manifest = this.buildJobManifest(
      jobName,
      node,
      script,
      includeShared,
    );
    await this.kubernetesService.applyManifest(kubeconfig, manifest);

    try {
      await this.awaitJob(kubeconfig, jobName);
      const logs = await this.readJobLogs(kubeconfig, jobName);
      return this.parse(logs, node);
    } finally {
      // The Job carries a TTL of its own; this only stops a failed probe from
      // lingering, and must never mask the error that brought us here.
      await this.kubernetesService
        .deleteResource(kubeconfig, 'Job', jobName, JOB_NAMESPACE)
        .catch(() => undefined);
    }
  }

  private buildJobManifest(
    jobName: string,
    node: string,
    script: string,
    includeShared: boolean,
  ): string {
    const escaped = script.replaceAll('"', String.raw`\"`);
    const lines = [
      'apiVersion: batch/v1',
      'kind: Job',
      'metadata:',
      `  name: ${jobName}`,
      `  namespace: ${JOB_NAMESPACE}`,
      '  labels:',
      '    flui.cloud/managed-by: flui-cloud',
      '    flui-resource-type: storage-usage',
      'spec:',
      '  ttlSecondsAfterFinished: 60',
      '  backoffLimit: 0',
      '  template:',
      '    metadata:',
      '      labels:',
      '        flui.cloud/managed-by: flui-cloud',
      '        flui-resource-type: storage-usage',
      `        flui-storage-usage-job: ${jobName}`,
      '    spec:',
      '      restartPolicy: Never',
      '      nodeSelector:',
      `        kubernetes.io/hostname: ${node}`,
      '      tolerations:',
      '      - key: node-role.kubernetes.io/control-plane',
      '        operator: Exists',
      '        effect: NoSchedule',
      '      - key: node-role.kubernetes.io/master',
      '        operator: Exists',
      '        effect: NoSchedule',
      '      containers:',
      '      - name: measure',
      '        image: busybox:1.36',
      '        command: ["sh","-c"]',
      `        args: ["${escaped}"]`,
      '        volumeMounts:',
      '        - name: local',
      '          mountPath: /host/local',
      '          readOnly: true',
    ];
    if (includeShared) {
      lines.push(
        '        - name: shared',
        '          mountPath: /host/shared',
        '          readOnly: true',
      );
    }
    lines.push(
      '      volumes:',
      '      - name: local',
      '        hostPath:',
      `          path: ${FLUI_LOCAL_STORAGE_PATH}`,
      '          type: DirectoryOrCreate',
    );
    if (includeShared) {
      lines.push(
        '      - name: shared',
        '        hostPath:',
        `          path: ${FLUI_SHARED_STORAGE_PATH}`,
        '          type: DirectoryOrCreate',
      );
    }
    lines.push('');
    return lines.join('\n');
  }

  private async awaitJob(kubeconfig: string, jobName: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < JOB_TIMEOUT_MS) {
      const job = await this.kubernetesService.getResource(
        kubeconfig,
        'Job',
        jobName,
        JOB_NAMESPACE,
      );
      if ((job?.status?.succeeded ?? 0) > 0) return;
      if ((job?.status?.failed ?? 0) > 0) {
        throw new Error(`measurement job ${jobName} failed`);
      }
      await new Promise((r) => setTimeout(r, JOB_POLL_MS));
    }
    throw new Error(`measurement job ${jobName} timed out`);
  }

  private async readJobLogs(
    kubeconfig: string,
    jobName: string,
  ): Promise<string> {
    const kc = this.kubernetesService.makeKubeConfig(kubeconfig);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const pods = await coreApi.listNamespacedPod({
      namespace: JOB_NAMESPACE,
      labelSelector: `flui-storage-usage-job=${jobName}`,
    });
    const podName = pods.items?.[0]?.metadata?.name;
    if (!podName) throw new Error(`no pod found for job ${jobName}`);
    return this.kubernetesService.getPodLogs(
      kubeconfig,
      podName,
      JOB_NAMESPACE,
    );
  }

  /**
   * `local<TAB>pvc-<uid>_<namespace>_<claim><TAB><kilobytes>`
   *
   * A directory whose name does not carry the namespace is skipped rather than
   * guessed at: attributing somebody else's data to a tenancy is worse than
   * leaving a row out of the report.
   */
  private parse(logs: string, node: string): VolumeUsage[] {
    const rows: VolumeUsage[] = [];
    for (const line of logs.split('\n')) {
      const [kind, dir, kb] = line.trim().split('\t');
      if (!kind || !dir || !kb) continue;
      if (kind !== 'local' && kind !== 'shared') continue;

      const parts = dir.split('_');
      if (parts.length < 3) continue;
      const [, namespace, ...claim] = parts;
      const bytes = Number(kb) * 1024;
      if (!Number.isFinite(bytes)) continue;

      rows.push({
        volumeName: claim.join('_'),
        namespace,
        kind,
        node,
        bytes,
      });
    }
    return rows;
  }
}
