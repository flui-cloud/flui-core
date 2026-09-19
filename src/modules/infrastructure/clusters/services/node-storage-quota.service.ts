import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as k8s from '@kubernetes/client-node';
import { ClusterEntity } from '../entities/cluster.entity';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { KubernetesService } from '../../shared/services/kubernetes.service';

const FLUI_LOCAL_STORAGE_PATH = '/var/lib/flui/local';
const JOB_NAMESPACE = 'flui-system';
const JOB_TIMEOUT_MS = 180_000;
const JOB_POLL_MS = 2_000;

/**
 * Project ids below this are left to the system; 0 in particular is "no
 * project", which every untagged file already carries.
 */
const FIRST_PROJECT_ID = 1000;

export interface TenancyStorageLimit {
  namespace: string;
  bytes: number;
}

export interface TenancyQuotaState {
  namespace: string;
  projectId: number;
  usedBytes: number;
  limitBytes: number;
}

export interface NodeQuotaResult {
  node: string;
  /** False when this node's local storage is a plain folder with no quota support. */
  supported: boolean;
  reason?: string;
  tenancies: TenancyQuotaState[];
}

export interface StorageQuotaReconciliation {
  reconciledAt: string;
  nodes: NodeQuotaResult[];
}

/**
 * A stable project id for a tenancy.
 *
 * Derived from the name rather than handed out in sequence, because the id is
 * written into the filesystem and has to survive this service forgetting
 * everything: an id that drifted would strand the directories already tagged
 * with the old one, splitting a tenancy's usage across two projects and
 * quietly doubling what it may write.
 */
export function projectIdFor(namespace: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < namespace.length; i++) {
    hash ^= namespace.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return FIRST_PROJECT_ID + (hash % (0x7fffffff - FIRST_PROJECT_ID));
}

/**
 * Giving each tenancy a ceiling on the node's own disk, and reading back what
 * it has used.
 *
 * This is the half that makes a guest's declared storage mean something. Their
 * `ResourceQuota` says 12Gi, but a `requests.storage` ceiling only counts the
 * sizes written on claims, and local-path enforces none of them — a claim of
 * 1Mi was measured accepting 50MiB. So the number is a promise the product has
 * never kept, and this keeps it, using the only mechanism that actually
 * refuses a write: XFS project quotas, applied to the directory tree.
 *
 * It reconciles rather than hooking volume creation, and that is deliberate.
 * The obvious place would be the provisioner's `setup` script, which runs on
 * the right node at the right moment — but a failure there fails the volume,
 * which would mean a bug in a guest-only feature breaking every application
 * that keeps data. Here the worst outcome is a tenancy that is not capped yet.
 *
 * Nodes whose local storage is still a plain folder answer `supported: false`
 * and are left alone, so this is safe to run against a cluster that has not
 * been rebuilt with a quota-capable filesystem.
 */
@Injectable()
export class NodeStorageQuotaService {
  private readonly logger = new Logger(NodeStorageQuotaService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
  ) {}

  /**
   * @param limits one entry per tenancy that should have a ceiling. A tenancy
   *   absent from this list is measured but never limited, which is how
   *   everybody who is not a guest keeps working exactly as before.
   */
  async reconcile(
    clusterId: string,
    limits: TenancyStorageLimit[],
  ): Promise<StorageQuotaReconciliation> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new BadRequestException(
        `Cluster ${clusterId} not found, or has no kubeconfig`,
      );
    }
    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );

    const planned = this.plan(limits);
    const nodes = await this.listNodes(kubeconfig);
    const results: NodeQuotaResult[] = [];

    for (const node of nodes) {
      try {
        results.push(await this.runOnNode(kubeconfig, node, planned));
      } catch (error) {
        results.push({
          node,
          supported: false,
          reason: (error as Error).message,
          tenancies: [],
        });
        this.logger.warn(
          `Storage quota reconcile failed on ${node}: ${(error as Error).message}`,
        );
      }
    }

    return { reconciledAt: new Date().toISOString(), nodes: results };
  }

  /**
   * Two tenancies landing on the same project id would silently share one
   * ceiling — each of them able to write the other's allowance. Astronomically
   * unlikely in a 31-bit space with tens of live tenancies, and refused rather
   * than trusted, because the failure is invisible from the outside.
   */
  private plan(
    limits: TenancyStorageLimit[],
  ): Array<TenancyStorageLimit & { projectId: number }> {
    const byId = new Map<number, string>();
    const planned: Array<TenancyStorageLimit & { projectId: number }> = [];

    for (const limit of limits) {
      const projectId = projectIdFor(limit.namespace);
      const clash = byId.get(projectId);
      if (clash && clash !== limit.namespace) {
        this.logger.error(
          `Refusing to cap ${limit.namespace}: its project id ${projectId} collides with ${clash}`,
        );
        continue;
      }
      byId.set(projectId, limit.namespace);
      planned.push({ ...limit, projectId });
    }
    return planned;
  }

  private async listNodes(kubeconfig: string): Promise<string[]> {
    const kc = this.kubernetesService.makeKubeConfig(kubeconfig);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const list = await coreApi.listNode();
    return (list.items ?? [])
      .map((n) => n.metadata?.name)
      .filter((n): n is string => Boolean(n));
  }

  private async runOnNode(
    kubeconfig: string,
    node: string,
    planned: Array<TenancyStorageLimit & { projectId: number }>,
  ): Promise<NodeQuotaResult> {
    const jobName = `flui-storage-quota-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;

    const manifest = this.buildJobManifest(jobName, node, planned);
    await this.kubernetesService.applyManifest(kubeconfig, manifest);

    try {
      await this.awaitJob(kubeconfig, jobName);
      const logs = await this.readJobLogs(kubeconfig, jobName);
      return this.parse(logs, node, planned);
    } finally {
      await this.kubernetesService
        .deleteResource(kubeconfig, 'Job', jobName, JOB_NAMESPACE)
        .catch(() => undefined);
    }
  }

  /**
   * The script is deliberately dull, because it runs privileged on every node.
   *
   * It refuses to do anything at all unless the mount says `prjquota`, tags
   * each volume directory with its tenancy's project, applies the ceiling, and
   * prints what the kernel now believes. A directory whose name does not carry
   * a tenancy is skipped rather than guessed at.
   */
  private buildScript(
    planned: Array<TenancyStorageLimit & { projectId: number }>,
  ): string {
    const table = planned
      .map((p) => `${p.namespace}:${p.projectId}:${p.bytes}`)
      .join(' ');

    return [
      'set -e',
      `ROOT=${FLUI_LOCAL_STORAGE_PATH}`,
      // Nothing here is safe or meaningful on a filesystem without project
      // quotas, and saying so is a better answer than half-applying.
      `if ! findmnt -no OPTIONS "$ROOT" 2>/dev/null | grep -q prjquota; then echo "UNSUPPORTED no project quota on $ROOT"; exit 0; fi`,
      'apk add --no-cache xfsprogs >/dev/null 2>&1 || true',
      `if ! command -v xfs_quota >/dev/null 2>&1; then echo "UNSUPPORTED xfs_quota unavailable"; exit 0; fi`,
      `TABLE="${table}"`,
      'for d in "$ROOT"/*; do',
      '  [ -d "$d" ] || continue',
      '  base=$(basename "$d")',
      '  ns=$(echo "$base" | cut -d_ -f2)',
      '  [ -n "$ns" ] || continue',
      '  for entry in $TABLE; do',
      '    ens=$(echo "$entry" | cut -d: -f1)',
      '    eid=$(echo "$entry" | cut -d: -f2)',
      '    if [ "$ens" = "$ns" ]; then',
      '      xfs_quota -x -c "project -s -p $d $eid" "$ROOT" >/dev/null 2>&1 || true',
      '    fi',
      '  done',
      'done',
      'for entry in $TABLE; do',
      '  ens=$(echo "$entry" | cut -d: -f1)',
      '  eid=$(echo "$entry" | cut -d: -f2)',
      '  ebytes=$(echo "$entry" | cut -d: -f3)',
      '  xfs_quota -x -c "limit -p bhard=$ebytes $eid" "$ROOT" >/dev/null 2>&1 || true',
      'done',
      `xfs_quota -x -c 'report -p -N -b' "$ROOT" 2>/dev/null | sed 's/^/REPORT /'`,
    ].join('\n');
  }

  private buildJobManifest(
    jobName: string,
    node: string,
    planned: Array<TenancyStorageLimit & { projectId: number }>,
  ): string {
    // A YAML block scalar rather than a quoted one-liner: joining the lines
    // with `;` turns `for … do` into `do;`, which sh refuses. Indentation is
    // the only escaping here.
    const scriptBlock = this.buildScript(planned)
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
      '    flui-resource-type: storage-quota',
      'spec:',
      '  ttlSecondsAfterFinished: 60',
      '  backoffLimit: 0',
      '  template:',
      '    metadata:',
      '      labels:',
      '        flui.cloud/managed-by: flui-cloud',
      '        flui-resource-type: storage-quota',
      `        flui-storage-quota-job: ${jobName}`,
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
      '      - name: quota',
      '        image: alpine:3.20',
      '        securityContext:',
      '          privileged: true',
      '        command: ["sh","-c"]',
      '        args:',
      '        - |',
      scriptBlock,
      '        volumeMounts:',
      '        - name: local',
      `          mountPath: ${FLUI_LOCAL_STORAGE_PATH}`,
      '      volumes:',
      '      - name: local',
      '        hostPath:',
      `          path: ${FLUI_LOCAL_STORAGE_PATH}`,
      '          type: DirectoryOrCreate',
      '',
    ].join('\n');
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
        throw new Error(`quota job ${jobName} failed`);
      }
      await new Promise((r) => setTimeout(r, JOB_POLL_MS));
    }
    throw new Error(`quota job ${jobName} timed out`);
  }

  private async readJobLogs(
    kubeconfig: string,
    jobName: string,
  ): Promise<string> {
    const kc = this.kubernetesService.makeKubeConfig(kubeconfig);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const pods = await coreApi.listNamespacedPod({
      namespace: JOB_NAMESPACE,
      labelSelector: `flui-storage-quota-job=${jobName}`,
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
   * `REPORT <projectId> <usedKb> <softKb> <hardKb> ...`, which is what
   * `xfs_quota report -p -N -b` prints once the `#` is stripped from the id.
   */
  private parse(
    logs: string,
    node: string,
    planned: Array<TenancyStorageLimit & { projectId: number }>,
  ): NodeQuotaResult {
    const unsupported = logs
      .split('\n')
      .find((l) => l.trim().startsWith('UNSUPPORTED'));
    if (unsupported) {
      return {
        node,
        supported: false,
        reason: unsupported.replace('UNSUPPORTED', '').trim(),
        tenancies: [],
      };
    }

    const byProject = new Map(planned.map((p) => [p.projectId, p.namespace]));
    const tenancies: TenancyQuotaState[] = [];

    for (const line of logs.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('REPORT ')) continue;
      const cols = trimmed.slice('REPORT '.length).trim().split(/\s+/);
      const projectId = Number(cols[0]?.replace('#', ''));
      const namespace = byProject.get(projectId);
      if (!namespace) continue;

      tenancies.push({
        namespace,
        projectId,
        usedBytes: Number(cols[1] ?? 0) * 1024,
        limitBytes: Number(cols[3] ?? 0) * 1024,
      });
    }

    return { node, supported: true, tenancies };
  }
}
