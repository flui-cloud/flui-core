import { Injectable, Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  KOPIA_REPO_LABEL,
  kopiaJobDeadlineSeconds,
  kopiaSecretName,
  renderKopiaSecret,
} from '../../backups/utils/kopia-job.manifest';
import {
  KopiaSnapshotJobInput,
  renderKopiaSnapshotJob,
} from '../../backups/utils/kopia-snapshot-job.manifest';
import {
  KopiaRestoreJobInput,
  renderKopiaRestoreJob,
} from '../../backups/utils/kopia-restore-job.manifest';
import {
  KopiaSnapshotOutcome,
  parseKopiaSnapshotLog,
} from '../../backups/utils/kopia-snapshot-outcome.util';
import { KopiaJobQueue } from '../../backups/utils/kopia-queue.util';

const POLL_MS = 5000;
/** Waiting for another Job on the same repository, before giving up. */
const PEER_WAIT_MS = 30 * 60 * 1000;
const MAX_CONCURRENT_JOBS = 2;

export interface KopiaCredentials {
  password: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface KopiaSourceVolume {
  sizeGb: number;
  nodeName?: string;
  storageClassName?: string;
}

/**
 * The kopia Jobs on a workload cluster: one snapshot of one volume, or one
 * restore into one volume.
 *
 * The Job carries everything it needs; this service only places it, waits for
 * it and reads what it reported. Each Job has a Secret of its own for exactly
 * as long as it runs.
 */
@Injectable()
export class KopiaVolumeEngineService {
  private readonly logger = new Logger(KopiaVolumeEngineService.name);
  private readonly queue = new KopiaJobQueue(MAX_CONCURRENT_JOBS);

  constructor(private readonly k8s: KubernetesService) {}

  async sourceVolume(
    kubeconfig: string,
    namespace: string,
    pvcName: string,
  ): Promise<KopiaSourceVolume> {
    const pvc = await this.k8s.getResource(
      kubeconfig,
      'PersistentVolumeClaim',
      pvcName,
      namespace,
    );
    if (!pvc) throw new Error(`Volume ${namespace}/${pvcName} not found`);
    return {
      sizeGb: parseStorageGb(
        pvc?.status?.capacity?.storage ??
          pvc?.spec?.resources?.requests?.storage,
      ),
      nodeName:
        pvc?.metadata?.annotations?.['volume.kubernetes.io/selected-node'],
      storageClassName: pvc?.spec?.storageClassName,
    };
  }

  async snapshot(args: {
    kubeconfig: string;
    repositoryKey: string;
    credentials: KopiaCredentials;
    job: Omit<KopiaSnapshotJobInput, 'labels'> & {
      labels: Record<string, string>;
    };
  }): Promise<KopiaSnapshotOutcome> {
    const { job } = args;
    return this.queue.run(args.repositoryKey, async () => {
      const labels = { ...job.labels, [KOPIA_REPO_LABEL]: args.repositoryKey };
      await this.waitForPeers(
        args.kubeconfig,
        job.namespace,
        args.repositoryKey,
      );
      const manifest = renderKopiaSnapshotJob({ ...job, labels });
      const log = await this.runJob({
        kubeconfig: args.kubeconfig,
        namespace: job.namespace,
        jobName: job.jobName,
        labels,
        credentials: args.credentials,
        manifest,
        deadlineSeconds: kopiaJobDeadlineSeconds(job.sizeGb),
      });
      const outcome = parseKopiaSnapshotLog(log);
      if (!outcome.primary?.id) {
        throw new Error(
          `The kopia Job ${job.jobName} finished without reporting a snapshot`,
        );
      }
      return outcome;
    });
  }

  async restore(args: {
    kubeconfig: string;
    repositoryKey: string;
    credentials: KopiaCredentials;
    job: KopiaRestoreJobInput;
  }): Promise<{ bytes?: number; restoredPaths?: number }> {
    return this.queue.run(`restore:${args.job.targetPvcName}`, async () => {
      const labels = {
        ...args.job.labels,
        [KOPIA_REPO_LABEL]: args.repositoryKey,
      };
      const log = await this.runJob({
        kubeconfig: args.kubeconfig,
        namespace: args.job.namespace,
        jobName: args.job.jobName,
        labels,
        credentials: args.credentials,
        manifest: renderKopiaRestoreJob({ ...args.job, labels }),
        deadlineSeconds: kopiaJobDeadlineSeconds(args.job.sizeGb),
      });
      const bytes = /^FLUI_ACTUAL_BYTES=(\d+)$/m.exec(log);
      const paths = /^FLUI_KOPIA_RESTORED_PATHS=(\d+)$/m.exec(log);
      return {
        bytes: bytes ? Number(bytes[1]) : undefined,
        restoredPaths: paths ? Number(paths[1]) : undefined,
      };
    });
  }

  async createVolume(args: {
    kubeconfig: string;
    namespace: string;
    name: string;
    storageClassName: string;
    sizeGb: number;
    labels: Record<string, string>;
  }): Promise<void> {
    await this.k8s.applyManifest(
      args.kubeconfig,
      JSON.stringify({
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
          name: args.name,
          namespace: args.namespace,
          labels: args.labels,
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          storageClassName: args.storageClassName,
          resources: {
            requests: { storage: `${Math.max(1, Math.ceil(args.sizeGb))}Gi` },
          },
        },
      }),
    );
  }

  /**
   * Another Job on the same repository — started by another API process, or
   * left from before a restart — is waited for rather than raced.
   */
  private async waitForPeers(
    kubeconfig: string,
    namespace: string,
    repositoryKey: string,
  ): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < PEER_WAIT_MS) {
      const jobs = await this.k8s
        .listResourcesByLabel(
          kubeconfig,
          'Job',
          namespace,
          `${KOPIA_REPO_LABEL}=${repositoryKey}`,
        )
        .catch(() => [] as any[]);
      if (!jobs.some((j: any) => (j?.status?.active ?? 0) > 0)) return;
      await sleep(POLL_MS * 2);
    }
    throw new Error(
      'Another kopia Job on this repository has been running for 30 minutes; not starting a second one',
    );
  }

  private async runJob(args: {
    kubeconfig: string;
    namespace: string;
    jobName: string;
    labels: Record<string, string>;
    credentials: KopiaCredentials;
    manifest: Record<string, unknown>;
    deadlineSeconds: number;
  }): Promise<string> {
    const secretName = kopiaSecretName(args.jobName);
    await this.k8s.applyManifest(
      args.kubeconfig,
      JSON.stringify(
        renderKopiaSecret({
          name: secretName,
          namespace: args.namespace,
          labels: args.labels,
          ...args.credentials,
        }),
      ),
    );
    try {
      await this.k8s.applyManifest(
        args.kubeconfig,
        JSON.stringify(args.manifest),
      );
      const succeeded = await this.waitForJob(
        args.kubeconfig,
        args.namespace,
        args.jobName,
        args.deadlineSeconds + 120,
      );
      const log = await this.readLog(
        args.kubeconfig,
        args.namespace,
        args.jobName,
      );
      if (!succeeded) {
        const tail = log
          .split('\n')
          .filter((l) => l.trim() && !l.startsWith('FLUI_'))
          .slice(-4)
          .join(' ');
        const detail = tail ? `: ${tail.slice(0, 400)}` : '';
        throw new Error(
          `kopia Job ${args.namespace}/${args.jobName} failed${detail}`,
        );
      }
      return log;
    } finally {
      await this.cleanup(
        args.kubeconfig,
        args.namespace,
        args.jobName,
        secretName,
      );
    }
  }

  private async waitForJob(
    kubeconfig: string,
    namespace: string,
    jobName: string,
    timeoutSeconds: number,
  ): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutSeconds * 1000) {
      const job = await this.k8s.getResource(
        kubeconfig,
        'Job',
        jobName,
        namespace,
      );
      if ((job?.status?.succeeded ?? 0) > 0) return true;
      const failed = (job?.status?.conditions ?? []).some(
        (c: any) => c?.type === 'Failed' && c?.status === 'True',
      );
      if (failed) return false;
      await sleep(POLL_MS);
    }
    return false;
  }

  private async readLog(
    kubeconfig: string,
    namespace: string,
    jobName: string,
  ): Promise<string> {
    try {
      const pods = await this.k8s.listResourcesByLabel(
        kubeconfig,
        'Pod',
        namespace,
        `job-name=${jobName}`,
      );
      const ordered = [...pods].sort((a: any, b: any) =>
        String(b?.metadata?.creationTimestamp ?? '').localeCompare(
          String(a?.metadata?.creationTimestamp ?? ''),
        ),
      );
      const pod =
        ordered.find((p: any) => p?.status?.phase === 'Succeeded') ??
        ordered[0];
      const name = pod?.metadata?.name as string | undefined;
      if (!name) return '';
      return await this.k8s.getPodLogs(
        kubeconfig,
        name,
        namespace,
        'kopia',
        300,
      );
    } catch (err: any) {
      this.logger.warn(
        `[kopia] could not read the log of ${namespace}/${jobName}: ${err?.message}`,
      );
      return '';
    }
  }

  private async cleanup(
    kubeconfig: string,
    namespace: string,
    jobName: string,
    secretName: string,
  ): Promise<void> {
    const pods = await this.k8s
      .listResourcesByLabel(kubeconfig, 'Pod', namespace, `job-name=${jobName}`)
      .catch(() => [] as any[]);
    for (const pod of pods) {
      const name = pod?.metadata?.name as string | undefined;
      if (name) {
        await this.k8s
          .deleteResource(kubeconfig, 'Pod', name, namespace)
          .catch(() => undefined);
      }
    }
    await this.k8s
      .deleteResource(kubeconfig, 'Job', jobName, namespace)
      .catch(() => undefined);
    await this.k8s
      .deleteResource(kubeconfig, 'Secret', secretName, namespace)
      .catch((err: any) =>
        this.logger.warn(
          `[kopia] Secret ${namespace}/${secretName} not removed: ${err?.message}`,
        ),
      );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function parseStorageGb(value: unknown): number {
  const match = /^(\d+(?:\.\d+)?)([KMGTP]i?)?$/.exec(
    typeof value === 'string' || typeof value === 'number' ? String(value) : '',
  );
  if (!match) return 0;
  const n = Number.parseFloat(match[1]);
  const factor: Record<string, number> = {
    Ki: 1 / (1024 * 1024),
    Mi: 1 / 1024,
    Gi: 1,
    Ti: 1024,
    Pi: 1024 * 1024,
    K: 1e-6,
    M: 1e-3,
    G: 1,
    T: 1e3,
    P: 1e6,
  };
  return n * (factor[match[2] ?? ''] ?? 1 / (1024 * 1024 * 1024));
}
