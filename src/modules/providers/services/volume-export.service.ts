import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  CreateExportInput,
  DeleteExportInput,
  ExportResult,
  ExportSinkKind,
  ExportSummary,
  IVolumeExport,
  ListExportsInput,
  PvcCloneExportInput,
  RestorePvcFromExportInput,
  S3ArchiveExportInput,
  VolumeExportCapabilities,
} from '../interfaces/volume-export.interface';

const TAR_IMAGE = 'busybox:1.37';
const RCLONE_IMAGE = 'rclone/rclone:1.67';

/**
 * What rclone says when the source changed while it was being read. Each
 * string was confirmed present in the pinned image's binary, so they are tied
 * to that pin: re-check them when RCLONE_IMAGE moves.
 */
const RCLONE_TEAR_MARKERS = [
  'corrupted on transfer',
  'source file is being updated',
  'hash differ',
];

/** A probe reads one directory listing; it never needs the copy's budget. */
const PROBE_JOB_TIMEOUT_SECONDS = 120;

/**
 * Whether a copy taken while the engine was writing can be restored at all.
 *
 * The distinction is not "risky" versus "safe" — it is whether the artifact
 * `--allow-inconsistent` would produce deserves to be called a backup. An
 * engine that survives a power cut survives a live copy, because a live copy is
 * what a power cut leaves behind. An engine whose store is written in place
 * does not: the copy is corrupt on arrival and will not open.
 */
export type LiveCopyClass = 'crash-consistent' | 'not-restorable';

export interface DataDirMarker {
  engine: string;
  /**
   * A `find -path` pattern, matched against the volume root.
   *
   * Paths rather than bare names, because a two-component path is two markers
   * agreeing for free: it needs a specific parent *and* a specific child.
   * `meta.properties` or `nodes` alone are names an ordinary application could
   * plausibly ship; `*​/__cluster_metadata-0` and `*​/nodes/0/_state` are not.
   */
  path: string;
  liveCopy: LiveCopyClass;
  /**
   * Other catalog engines this same marker detects.
   *
   * Forks share their ancestor's on-disk layout: MariaDB writes InnoDB's
   * `ibdata1`, Valkey writes Redis's `dump.rdb`. One path cannot tell them
   * apart and does not need to — what matters for a copy is what the format
   * is, not which project wrote it. Declared so the catalog-coverage test can
   * see they are handled rather than missing.
   */
  alsoDetects?: readonly string[];
}

/**
 * How a database announces itself on disk.
 *
 * This is the signal the refusal keys on, deliberately instead of the
 * `flui.cloud/db-engine` label: that label is stamped only when a catalog
 * component declares an engine, so it marks the databases Flui installed and
 * misses the raw container inside a composed application — the case that
 * actually tears under a live copy. The disk does not care how the workload was
 * installed.
 *
 * Every entry must be present no later than the engine's first durable write.
 * An engine whose volume holds no regular files at all is not a gap: there is
 * nothing to tear, and the probe says so. The gap is files with no marker, and
 * that is reported as `unrecognised` rather than silently copied.
 */
const DATA_DIR_MARKERS: ReadonlyArray<DataDirMarker> = [
  { engine: 'postgres', path: '*/PG_VERSION', liveCopy: 'not-restorable' },
  {
    engine: 'mysql',
    path: '*/ibdata1',
    liveCopy: 'crash-consistent',
    alsoDetects: ['mariadb'],
  },
  { engine: 'mongodb', path: '*/WiredTiger', liveCopy: 'crash-consistent' },
  {
    engine: 'redis',
    path: '*/dump.rdb',
    liveCopy: 'crash-consistent',
    alsoDetects: ['valkey'],
  },
  // Redis 7+ multi-part AOF lives in a directory, so the old `appendonly.aof`
  // name never matches on a modern install with AOF enabled.
  { engine: 'redis', path: '*/appendonlydir', liveCopy: 'crash-consistent' },
  { engine: 'nats', path: '*/jetstream', liveCopy: 'crash-consistent' },
  {
    engine: 'rabbitmq',
    path: '*/mnesia/rabbit@*',
    liveCopy: 'crash-consistent',
  },
  {
    engine: 'kafka',
    path: '*/__cluster_metadata-0',
    liveCopy: 'crash-consistent',
  },
  {
    engine: 'openbao',
    path: '*/core/_seal-config',
    liveCopy: 'crash-consistent',
  },
  // LMDB writes pages in place: a torn `data.mdb` is MDB_CORRUPTED and the
  // engine will not open it. There is no partial recovery to attempt.
  {
    engine: 'meilisearch',
    path: '*/data.ms/VERSION',
    liveCopy: 'not-restorable',
  },
  { engine: 'garage', path: '*/meta/db.lmdb', liveCopy: 'not-restorable' },
  // A `segments_N` copied out of step with the segment files it names leaves a
  // shard that cannot be opened, and the cluster state disagrees with it.
  {
    engine: 'opensearch',
    path: '*/nodes/0/_state',
    liveCopy: 'not-restorable',
  },
];

export function liveCopyClassOf(engine: string): LiveCopyClass | undefined {
  return DATA_DIR_MARKERS.find((m) => m.engine === engine)?.liveCopy;
}

/** Every engine the probe can name, for the catalog-coverage test. */
export const PROBEABLE_ENGINES: ReadonlySet<string> = new Set(
  DATA_DIR_MARKERS.flatMap((m) => [m.engine, ...(m.alsoDetects ?? [])]),
);
const PVC_CLONE_LABEL = 'flui.cloud/pvc-clone-export';
const SOURCE_PVC_LABEL = 'flui.cloud/exported-from';
const SINK_LABEL = 'flui.cloud/export-sink';
const COPY_JOB_TIMEOUT_SECONDS = 30 * 60;

/**
 * Universal volume export primitive based on the copy-pod pattern.
 *
 * One implementation serves every Flui-supported provider: the storage class
 * is always `local-path` (rancher.io/local-path) on top of NFS+fscache,
 * therefore "snapshot" / "backup" cannot rely on CSI VolumeSnapshot. Both
 * sink kinds — pvc-clone and s3-archive — funnel through a Job that mounts
 * the source PVC and streams data to the chosen sink.
 *
 * Provider-specific behavior (cost, capabilities) is exposed through
 * `capabilities` so the upper layers can warn / price accordingly.
 */
@Injectable()
export class VolumeExportService implements IVolumeExport {
  private readonly logger = new Logger(VolumeExportService.name);

  readonly capabilities: VolumeExportCapabilities = {
    pvcCloneSupportsCheapRetention: false,
    s3ArchiveSupportsCheapRetention: true,
    pvcClonePricePerGbMonthEur: null,
    s3ArchivePricePerGbMonthEur: null,
  };

  constructor(private readonly k8s: KubernetesService) {}

  async createExport(input: CreateExportInput): Promise<ExportResult> {
    if (input.sink === 'pvc-clone') {
      return this.createPvcCloneExport(input);
    }
    return this.createS3ArchiveExport(input);
  }

  async listExports(input: ListExportsInput): Promise<ExportSummary[]> {
    const namespace = input.namespace ?? '';
    if (!namespace) {
      this.logger.debug(
        '[volume-export] list across all namespaces not supported here; pass namespace',
      );
      return [];
    }

    const labelParts: string[] = [];
    if (input.sink) labelParts.push(`${SINK_LABEL}=${input.sink}`);
    else labelParts.push(`${PVC_CLONE_LABEL}=true`);
    if (input.labelSelector) labelParts.push(input.labelSelector);
    const labelSelector = labelParts.join(',');

    const items = await this.k8s.listResourcesByLabel(
      input.kubeconfig,
      'PersistentVolumeClaim',
      namespace,
      labelSelector,
    );

    return items.map((pvc: any) => {
      const labels = (pvc?.metadata?.labels as Record<string, string>) ?? {};
      const annotations =
        (pvc?.metadata?.annotations as Record<string, string>) ?? {};
      const sizeGb = this.parseStorageGb(
        pvc?.spec?.resources?.requests?.storage ?? '0',
      );
      const actualBytesRaw = annotations['flui.cloud/actual-bytes'];
      const actualBytes = actualBytesRaw
        ? Number.parseInt(actualBytesRaw, 10)
        : undefined;
      return {
        exportId: pvc?.metadata?.name as string,
        sink: 'pvc-clone' as ExportSinkKind,
        namespace: pvc?.metadata?.namespace as string,
        sourcePvcName: labels[SOURCE_PVC_LABEL],
        appId: labels['flui-app-id'],
        sizeGb,
        actualBytes: Number.isFinite(actualBytes) ? actualBytes : undefined,
        createdAt:
          (pvc?.metadata?.creationTimestamp as string) ??
          new Date().toISOString(),
        ready: pvc?.status?.phase === 'Bound',
        labels,
      };
    });
  }

  async deleteExport(input: DeleteExportInput): Promise<void> {
    if (input.sink === 'pvc-clone') {
      try {
        await this.k8s.deleteResource(
          input.kubeconfig,
          'PersistentVolumeClaim',
          input.exportId,
          input.namespace,
        );
      } catch (err: any) {
        if (input.ignoreNotFound && err?.message?.includes('not found')) return;
        throw err;
      }
      return;
    }

    if (!input.s3) {
      throw new Error(
        'deleteExport(sink=s3-archive) requires s3 credentials in input.s3',
      );
    }

    const jobName = this.s3DeleteJobName(input.exportId);
    const jobManifest = this.renderS3DeleteJobManifest({
      jobName,
      namespace: input.namespace,
      keyPrefix: input.exportId,
      s3: input.s3,
      labels: {
        'flui.cloud/managed-by': 'flui-cloud',
        [SINK_LABEL]: 's3-archive',
      },
    });
    await this.k8s.applyManifest(input.kubeconfig, jobManifest);
    await this.waitForJobCompletion(
      input.kubeconfig,
      input.namespace,
      jobName,
      COPY_JOB_TIMEOUT_SECONDS,
    );
    await this.cleanupCopyJob(input.kubeconfig, input.namespace, jobName);
  }

  async restoreFromExport(
    input: RestorePvcFromExportInput,
  ): Promise<{ pvcName: string }> {
    const newPvcLabels: Record<string, string> = {
      ...input.labels,
      'flui.cloud/restored-from': input.exportId,
    };
    const pvcManifest = this.renderPvcManifest({
      name: input.newPvcName,
      namespace: input.namespace,
      storageClassName: input.storageClassName,
      storage: `${input.sizeGb}Gi`,
      labels: newPvcLabels,
    });
    await this.k8s.applyManifest(input.kubeconfig, pvcManifest);

    const jobName = `${input.newPvcName}-restore`;
    const jobManifest =
      input.sink === 'pvc-clone'
        ? this.renderTarCopyJobManifest({
            jobName,
            namespace: input.namespace,
            sourcePvcName: input.exportId,
            destPvcName: input.newPvcName,
            nodeSelectorHostname: input.preferredNode,
            labels: newPvcLabels,
          })
        : this.renderS3RestoreJobManifest({
            jobName,
            namespace: input.namespace,
            destPvcName: input.newPvcName,
            keyPrefix: input.exportId,
            s3: this.requireS3(input.s3),
            nodeSelectorHostname: input.preferredNode,
            labels: newPvcLabels,
          });
    await this.k8s.applyManifest(input.kubeconfig, jobManifest);
    await this.waitForJobCompletion(
      input.kubeconfig,
      input.namespace,
      jobName,
      COPY_JOB_TIMEOUT_SECONDS,
    );
    await this.cleanupCopyJob(input.kubeconfig, input.namespace, jobName);
    return { pvcName: input.newPvcName };
  }

  // ─── pvc-clone sink ────────────────────────────────────────────────────────

  private async createPvcCloneExport(
    input: PvcCloneExportInput,
  ): Promise<ExportResult> {
    const sourcePvc = await this.requireSourcePvc(
      input.kubeconfig,
      input.namespace,
      input.sourcePvcName,
    );
    const sourceUid = sourcePvc?.metadata?.uid as string | undefined;
    const storageRequest =
      sourcePvc?.spec?.resources?.requests?.storage ?? '10Gi';
    const sizeGb = this.parseStorageGb(storageRequest);
    const storageClass =
      input.destStorageClass ?? (sourcePvc?.spec?.storageClassName as string);
    const sourceNode = sourcePvc?.metadata?.annotations?.[
      'volume.kubernetes.io/selected-node'
    ] as string | undefined;

    const exportLabels: Record<string, string> = {
      ...input.labels,
      [PVC_CLONE_LABEL]: 'true',
      [SINK_LABEL]: 'pvc-clone',
      [SOURCE_PVC_LABEL]: input.sourcePvcName,
      ...(sourceUid ? { 'flui.cloud/source-pvc-uid': sourceUid } : {}),
    };

    const pvcManifest = this.renderPvcManifest({
      name: input.exportName,
      namespace: input.namespace,
      storageClassName: storageClass,
      storage: storageRequest,
      labels: exportLabels,
    });
    await this.k8s.applyManifest(input.kubeconfig, pvcManifest);

    // K8s auto-injects `batch.kubernetes.io/job-name=<jobName>` as a label
    // on the pod template, and label values must be ≤63 chars. The natural
    // `${exportName}-copy` form overflows for long descriptive exportIds
    // (e.g. `<app>-<rand>-snap-<ts>-<description>-copy` easily hits 64+).
    // Hash-suffix the name once we cross the line so the operation never
    // fails just because the user picked a descriptive snapshot name.
    const naturalName = `${input.exportName}-copy`;
    const jobName =
      naturalName.length <= 63
        ? naturalName
        : `copy-${this.shortId(input.exportName)}`;
    const jobManifest = this.renderTarCopyJobManifest({
      jobName,
      namespace: input.namespace,
      sourcePvcName: input.sourcePvcName,
      destPvcName: input.exportName,
      nodeSelectorHostname: sourceNode,
      labels: exportLabels,
    });
    await this.k8s.applyManifest(input.kubeconfig, jobManifest);
    await this.waitForJobCompletion(
      input.kubeconfig,
      input.namespace,
      jobName,
      COPY_JOB_TIMEOUT_SECONDS,
    );
    const actualBytes = await this.parseActualBytesFromJob(
      input.kubeconfig,
      input.namespace,
      jobName,
      /FLUI_ACTUAL_BYTES=(\d+)/,
    );
    if (actualBytes !== undefined) {
      await this.annotateExportPvc(
        input.kubeconfig,
        input.namespace,
        input.exportName,
        actualBytes,
      );
    }
    await this.cleanupCopyJob(input.kubeconfig, input.namespace, jobName);

    return {
      exportId: input.exportName,
      sink: 'pvc-clone',
      namespace: input.namespace,
      sourceSizeGb: sizeGb,
      actualBytes,
      createdAt: new Date().toISOString(),
      ready: true,
    };
  }

  // ─── s3-archive sink ──────────────────────────────────────────────────────

  private async createS3ArchiveExport(
    input: S3ArchiveExportInput,
  ): Promise<ExportResult> {
    const sourcePvc = await this.requireSourcePvc(
      input.kubeconfig,
      input.namespace,
      input.sourcePvcName,
    );
    const storageRequest =
      sourcePvc?.spec?.resources?.requests?.storage ?? '10Gi';
    const sizeGb = this.parseStorageGb(storageRequest);
    const sourceNode = sourcePvc?.metadata?.annotations?.[
      'volume.kubernetes.io/selected-node'
    ] as string | undefined;

    const exportLabels: Record<string, string> = {
      ...input.labels,
      [SINK_LABEL]: 's3-archive',
      [SOURCE_PVC_LABEL]: input.sourcePvcName,
    };

    const jobName = `s3up-${this.shortId(input.exportName)}`;
    const jobManifest = this.renderS3ExportJobManifest({
      jobName,
      namespace: input.namespace,
      sourcePvcName: input.sourcePvcName,
      keyPrefix: input.keyPrefix,
      s3: {
        bucket: input.bucket,
        endpoint: input.endpoint,
        region: input.region,
        accessKeyId: input.accessKeyId,
        secretAccessKey: input.secretAccessKey,
      },
      nodeSelectorHostname: sourceNode,
      labels: exportLabels,
    });
    await this.k8s.applyManifest(input.kubeconfig, jobManifest);
    await this.waitForJobCompletion(
      input.kubeconfig,
      input.namespace,
      jobName,
      COPY_JOB_TIMEOUT_SECONDS,
    );
    const { actualBytes, writesObservedDuringCopy } =
      await this.readCopyJobOutcome(
        input.kubeconfig,
        input.namespace,
        jobName,
        /FLUI_ACTUAL_BYTES=(\d+)/,
      );
    await this.cleanupCopyJob(input.kubeconfig, input.namespace, jobName);

    return {
      exportId: input.keyPrefix,
      sink: 's3-archive',
      namespace: input.namespace,
      sourceSizeGb: sizeGb,
      actualBytes,
      writesObservedDuringCopy,
      createdAt: new Date().toISOString(),
      ready: true,
    };
  }

  // ─── shared helpers ────────────────────────────────────────────────────────

  private async requireSourcePvc(
    kubeconfig: string,
    namespace: string,
    name: string,
  ): Promise<any> {
    const sourcePvc = await this.k8s.getResource(
      kubeconfig,
      'PersistentVolumeClaim',
      name,
      namespace,
    );
    if (!sourcePvc) {
      throw new Error(
        `Source PVC ${namespace}/${name} not found, cannot export`,
      );
    }
    return sourcePvc;
  }

  private requireS3(
    s3: DeleteExportInput['s3'],
  ): NonNullable<DeleteExportInput['s3']> {
    if (!s3) throw new Error('s3 credentials required for s3-archive sink');
    return s3;
  }

  private s3DeleteJobName(exportId: string): string {
    return `s3del-${this.shortId(exportId)}`;
  }

  private shortId(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }

  /**
   * Read the completed copy-pod logs and extract the actual byte count
   * emitted by the container as `FLUI_ACTUAL_BYTES=<n>` on its last line.
   * Returns undefined when the marker is missing or unparseable.
   */
  private async parseActualBytesFromJob(
    kubeconfig: string,
    namespace: string,
    jobName: string,
    marker: RegExp,
  ): Promise<number | undefined> {
    return (
      await this.readCopyJobOutcome(kubeconfig, namespace, jobName, marker)
    ).actualBytes;
  }

  /**
   * Reads the copy pod's log once for both the size it reported and whether it
   * saw the source change underneath it.
   *
   * The tear signal matters because it is otherwise invisible: rclone runs with
   * `--retries 2`, so a file that changed mid-transfer usually succeeds on the
   * second pass and the Job reports success — with the torn set already in the
   * bucket. The evidence exists only in this log, which is deleted with the pod
   * moments later, so it is read here or not at all.
   *
   * The tar sink has no counterpart — busybox tar emits no such warning —
   * which is why that path reports `undefined` rather than `false`.
   */
  private async readCopyJobOutcome(
    kubeconfig: string,
    namespace: string,
    jobName: string,
    marker: RegExp,
  ): Promise<{
    actualBytes?: number;
    writesObservedDuringCopy?: boolean;
  }> {
    try {
      const pods = await this.k8s.listResourcesByLabel(
        kubeconfig,
        'Pod',
        namespace,
        `job-name=${jobName}`,
      );
      const pod = pods.find(
        (p: any) => (p?.status?.phase as string | undefined) === 'Succeeded',
      );
      const podName = pod?.metadata?.name as string | undefined;
      if (!podName) return {};
      // Deliberately more than the size marker needs: a mid-transfer retry can
      // push its error far above the summary line at the end.
      const logs = await this.k8s.getPodLogs(
        kubeconfig,
        podName,
        namespace,
        undefined,
        500,
      );
      const match = marker.exec(logs);
      const parsed = match ? Number.parseInt(match[1], 10) : Number.NaN;
      return {
        actualBytes: Number.isFinite(parsed) ? parsed : undefined,
        writesObservedDuringCopy: RCLONE_TEAR_MARKERS.some((m) =>
          logs.includes(m),
        ),
      };
    } catch (err: any) {
      this.logger.warn(
        `[volume-export] could not read the copy log for ${namespace}/${jobName}: ${err.message}`,
      );
      return {};
    }
  }

  private async annotateExportPvc(
    kubeconfig: string,
    namespace: string,
    pvcName: string,
    actualBytes: number,
  ): Promise<void> {
    try {
      const kc = this.k8s.makeKubeConfig(kubeconfig);
      const client = k8s.KubernetesObjectApi.makeApiClient(kc);
      const patch = {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
          name: pvcName,
          namespace,
          annotations: {
            'flui.cloud/actual-bytes': String(actualBytes),
          },
        },
      };
      await client.patch(
        patch,
        undefined,
        undefined,
        'flui-api',
        undefined,
        k8s.PatchStrategy.StrategicMergePatch,
      );
    } catch (err: any) {
      this.logger.warn(
        `[volume-export] could not annotate PVC ${namespace}/${pvcName} with actual bytes: ${err.message}`,
      );
    }
  }

  private async cleanupCopyJob(
    kubeconfig: string,
    namespace: string,
    jobName: string,
  ): Promise<void> {
    try {
      const pods = await this.k8s.listResourcesByLabel(
        kubeconfig,
        'Pod',
        namespace,
        `job-name=${jobName}`,
      );
      for (const pod of pods) {
        const podName = pod?.metadata?.name as string | undefined;
        if (!podName) continue;
        await this.k8s
          .deleteResource(kubeconfig, 'Pod', podName, namespace)
          .catch((err: any) =>
            this.logger.warn(
              `[volume-export] Pod cleanup failed for ${namespace}/${podName}: ${err.message}`,
            ),
          );
      }
    } catch (err: any) {
      this.logger.warn(
        `[volume-export] Pod listing for cleanup failed in ${namespace}/${jobName}: ${err.message}`,
      );
    }
    await this.k8s
      .deleteResource(kubeconfig, 'Job', jobName, namespace)
      .catch((err: any) =>
        this.logger.warn(
          `[volume-export] Job cleanup failed for ${namespace}/${jobName}: ${err.message}`,
        ),
      );
  }

  private async waitForJobCompletion(
    kubeconfig: string,
    namespace: string,
    jobName: string,
    timeoutSeconds: number,
  ): Promise<void> {
    const pollIntervalMs = 5000;
    const start = Date.now();
    while (Date.now() - start < timeoutSeconds * 1000) {
      const job = await this.k8s.getResource(
        kubeconfig,
        'Job',
        jobName,
        namespace,
      );
      const succeeded = job?.status?.succeeded ?? 0;
      const failed = job?.status?.failed ?? 0;
      if (succeeded > 0) return;
      if (failed > 0) {
        throw new Error(
          `Copy-pod Job ${namespace}/${jobName} failed (failed=${failed})`,
        );
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw new Error(
      `Copy-pod Job ${namespace}/${jobName} timed out after ${timeoutSeconds}s`,
    );
  }

  /**
   * Looks for a database's on-disk fingerprint at the root of a PVC.
   *
   * A Job rather than an exec into a pod that already mounts the claim, for
   * three reasons that all bite on the population this is meant to catch. A
   * container mounting with `subPath` sees a subtree, so an exec in a composed
   * app's web container would answer "no database" about a volume whose other
   * subtree is the data directory. The tooling would be the tenant's `ls`,
   * which a hardened image may not ship at all. And running commands inside an
   * application container to take a backup is the wrong shape of privilege.
   * This mounts the PVC root read-only and uses Flui's own busybox, already on
   * every node because the copy Job uses it.
   *
   * Depth 3: `PGDATA` is routinely a subdirectory of the mount, to keep the
   * engine clear of `lost+found` on a fresh volume.
   *
   * Returns the engine found, `null` when the probe ran and found none, and
   * undefined when it could not run — the caller keeps those apart.
   */
  async probeDataDirectory(
    kubeconfig: string,
    namespace: string,
    pvcName: string,
  ): Promise<string | null | undefined> {
    const jobName = `flui-probe-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    try {
      const sourcePvc = await this.requireSourcePvc(
        kubeconfig,
        namespace,
        pvcName,
      );
      const sourceNode = sourcePvc?.metadata?.annotations?.[
        'volume.kubernetes.io/selected-node'
      ] as string | undefined;
      await this.k8s.applyManifest(
        kubeconfig,
        this.renderProbeJobManifest({
          jobName,
          namespace,
          sourcePvcName: pvcName,
          nodeSelectorHostname: sourceNode,
          labels: { 'flui.cloud/managed-by': 'flui-cloud' },
        }),
      );
      await this.waitForJobCompletion(
        kubeconfig,
        namespace,
        jobName,
        PROBE_JOB_TIMEOUT_SECONDS,
      );
      const { engine } = await this.readProbeResult(
        kubeconfig,
        namespace,
        jobName,
      );
      return engine;
    } catch (err: any) {
      this.logger.warn(
        `[volume-export] data-directory probe did not run for ${namespace}/${pvcName}: ${err.message}`,
      );
      return undefined;
    } finally {
      await this.cleanupCopyJob(kubeconfig, namespace, jobName).catch(() => {});
    }
  }

  private async readProbeResult(
    kubeconfig: string,
    namespace: string,
    jobName: string,
  ): Promise<{ engine: string | null | undefined }> {
    const pods = await this.k8s.listResourcesByLabel(
      kubeconfig,
      'Pod',
      namespace,
      `job-name=${jobName}`,
    );
    const podName = pods.find(
      (p: any) => (p?.status?.phase as string | undefined) === 'Succeeded',
    )?.metadata?.name as string | undefined;
    if (!podName) return { engine: undefined };
    const logs = await this.k8s.getPodLogs(
      kubeconfig,
      podName,
      namespace,
      undefined,
      50,
    );
    const match = /FLUI_DATA_DIR=(\S*)/.exec(logs);
    if (!match) return { engine: undefined };
    return { engine: match[1] === 'none' ? null : match[1] };
  }

  // ─── manifest renderers ────────────────────────────────────────────────────

  private renderProbeJobManifest(args: {
    jobName: string;
    namespace: string;
    sourcePvcName: string;
    nodeSelectorHostname?: string;
    labels: Record<string, string>;
  }): string {
    const labelLinesMeta = this.renderLabelLines(args.labels, '    ');
    const labelLinesPod = this.renderLabelLines(args.labels, '        ');
    const nodeSelectorBlock = args.nodeSelectorHostname
      ? [
          '      nodeSelector:',
          `        kubernetes.io/hostname: ${args.nodeSelectorHostname}`,
        ].join('\n')
      : '';
    // One walk, then match against what it found. A `find` per marker was
    // affordable at five markers and triples the probe's cost at fourteen, on
    // a volume whose top three levels can already hold tens of thousands of
    // entries.
    const matches = DATA_DIR_MARKERS.map(
      ({ engine, path }) =>
        `grep -qE '^${path.replaceAll('*', '[^ ]*')}$' /tmp/l && ` +
        `{ echo FLUI_DATA_DIR=${engine}; exit 0; }`,
    ).join('\n');
    const script = [
      'find /src -maxdepth 3 2>/dev/null > /tmp/l',
      matches,
      // A volume with no regular files at all cannot be torn, so `none` is a
      // fact about it rather than a failure to recognise it, and is kept apart
      // from the unrecognised case below.
      'if [ -z "$(find /src -maxdepth 3 -type f 2>/dev/null | head -1)" ]; then echo FLUI_DATA_DIR=none; exit 0; fi',
      // SQLite by content, not by name: the file is called whatever the
      // application felt like, and the header is exact where a name is a guess.
      String.raw`for f in $(find /src -maxdepth 3 -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) 2>/dev/null | head -20); do`,
      '  if head -c 15 "$f" 2>/dev/null | grep -q \'SQLite format 3\'; then echo FLUI_DATA_DIR=sqlite; exit 0; fi',
      'done',
      // Files, but nothing Flui knows. Said out loud so the next missing
      // marker arrives as a bug report instead of a copy nobody questioned.
      'echo FLUI_DATA_DIR=unrecognised',
      // Newlines, not `; `: a `for … do` followed by a semicolon is a syntax
      // error, and the script is base64-encoded on the way in so line breaks
      // cost nothing.
    ].join('\n');
    return [
      'apiVersion: batch/v1',
      'kind: Job',
      'metadata:',
      `  name: ${args.jobName}`,
      `  namespace: ${args.namespace}`,
      '  labels:',
      labelLinesMeta,
      'spec:',
      '  backoffLimit: 0',
      `  activeDeadlineSeconds: ${PROBE_JOB_TIMEOUT_SECONDS}`,
      '  ttlSecondsAfterFinished: 120',
      '  template:',
      '    metadata:',
      '      labels:',
      labelLinesPod,
      '    spec:',
      '      restartPolicy: Never',
      ...(nodeSelectorBlock ? [nodeSelectorBlock] : []),
      '      containers:',
      '        - name: probe',
      `          image: ${TAR_IMAGE}`,
      '          command:',
      '            - /bin/sh',
      '            - -c',
      // Base64 rather than an inline scalar: the script legitimately contains
      // single quotes, globs and backslashes, and every one of them is a way
      // for a shell fragment to break the YAML around it. Encoding removes the
      // whole class — the same reason `PgBackrestService` does it.
      `            - 'echo ${Buffer.from(script, 'utf-8').toString('base64')} | base64 -d | sh'`,
      '          volumeMounts:',
      '            - name: src',
      '              mountPath: /src',
      '              readOnly: true',
      '      volumes:',
      '        - name: src',
      '          persistentVolumeClaim:',
      `            claimName: ${args.sourcePvcName}`,
      '            readOnly: true',
      '',
    ].join('\n');
  }

  private renderPvcManifest(args: {
    name: string;
    namespace: string;
    storageClassName: string;
    storage: string;
    labels: Record<string, string>;
  }): string {
    const labelLines = this.renderLabelLines(args.labels, '    ');
    return [
      'apiVersion: v1',
      'kind: PersistentVolumeClaim',
      'metadata:',
      `  name: ${args.name}`,
      `  namespace: ${args.namespace}`,
      '  labels:',
      labelLines,
      'spec:',
      '  accessModes:',
      '    - ReadWriteOnce',
      `  storageClassName: ${args.storageClassName}`,
      '  resources:',
      '    requests:',
      `      storage: ${args.storage}`,
      '',
    ].join('\n');
  }

  private renderTarCopyJobManifest(args: {
    jobName: string;
    namespace: string;
    sourcePvcName: string;
    destPvcName: string;
    nodeSelectorHostname?: string;
    labels: Record<string, string>;
  }): string {
    const labelLinesMeta = this.renderLabelLines(args.labels, '    ');
    const labelLinesPod = this.renderLabelLines(args.labels, '        ');
    const nodeSelectorBlock = args.nodeSelectorHostname
      ? [
          '      nodeSelector:',
          `        kubernetes.io/hostname: ${args.nodeSelectorHostname}`,
        ].join('\n')
      : '';
    return [
      'apiVersion: batch/v1',
      'kind: Job',
      'metadata:',
      `  name: ${args.jobName}`,
      `  namespace: ${args.namespace}`,
      '  labels:',
      labelLinesMeta,
      'spec:',
      '  backoffLimit: 1',
      `  activeDeadlineSeconds: ${COPY_JOB_TIMEOUT_SECONDS}`,
      '  ttlSecondsAfterFinished: 600',
      '  template:',
      '    metadata:',
      '      labels:',
      labelLinesPod,
      '    spec:',
      '      restartPolicy: Never',
      ...(nodeSelectorBlock ? [nodeSelectorBlock] : []),
      '      containers:',
      '        - name: copy',
      `          image: ${TAR_IMAGE}`,
      '          command:',
      '            - /bin/sh',
      '            - -c',
      String.raw`            - 'set -e; cd /src && tar -cf - . | tar -C /dst -xf - && sync && echo FLUI_ACTUAL_BYTES=$(du -sb /dst | awk "{print \$1}")'`,
      '          volumeMounts:',
      '            - name: src',
      '              mountPath: /src',
      '              readOnly: true',
      '            - name: dst',
      '              mountPath: /dst',
      '      volumes:',
      '        - name: src',
      '          persistentVolumeClaim:',
      `            claimName: ${args.sourcePvcName}`,
      '            readOnly: true',
      '        - name: dst',
      '          persistentVolumeClaim:',
      `            claimName: ${args.destPvcName}`,
      '',
    ].join('\n');
  }

  private renderS3ExportJobManifest(args: {
    jobName: string;
    namespace: string;
    sourcePvcName: string;
    keyPrefix: string;
    s3: NonNullable<DeleteExportInput['s3']>;
    nodeSelectorHostname?: string;
    labels: Record<string, string>;
  }): string {
    const labelLinesMeta = this.renderLabelLines(args.labels, '    ');
    const labelLinesPod = this.renderLabelLines(args.labels, '        ');
    const nodeSelectorBlock = args.nodeSelectorHostname
      ? [
          '      nodeSelector:',
          `        kubernetes.io/hostname: ${args.nodeSelectorHostname}`,
        ].join('\n')
      : '';
    const remote = `flui:${args.s3.bucket}/${args.keyPrefix}`;
    return [
      'apiVersion: batch/v1',
      'kind: Job',
      'metadata:',
      `  name: ${args.jobName}`,
      `  namespace: ${args.namespace}`,
      '  labels:',
      labelLinesMeta,
      'spec:',
      '  backoffLimit: 1',
      `  activeDeadlineSeconds: ${COPY_JOB_TIMEOUT_SECONDS}`,
      '  ttlSecondsAfterFinished: 600',
      '  template:',
      '    metadata:',
      '      labels:',
      labelLinesPod,
      '    spec:',
      '      restartPolicy: Never',
      ...(nodeSelectorBlock ? [nodeSelectorBlock] : []),
      '      containers:',
      '        - name: rclone',
      `          image: ${RCLONE_IMAGE}`,
      '          command:',
      '            - /bin/sh',
      '            - -c',
      String.raw`            - 'rclone -v --retries 2 --s3-no-check-bucket sync /src "${remote}" && echo FLUI_ACTUAL_BYTES=$(du -sb /src | awk "{print \$1}")'`,
      this.renderS3EnvBlock(args.s3),
      '          volumeMounts:',
      '            - name: src',
      '              mountPath: /src',
      '              readOnly: true',
      '      volumes:',
      '        - name: src',
      '          persistentVolumeClaim:',
      `            claimName: ${args.sourcePvcName}`,
      '            readOnly: true',
      '',
    ].join('\n');
  }

  private renderS3RestoreJobManifest(args: {
    jobName: string;
    namespace: string;
    destPvcName: string;
    keyPrefix: string;
    s3: NonNullable<DeleteExportInput['s3']>;
    nodeSelectorHostname?: string;
    labels: Record<string, string>;
  }): string {
    const labelLinesMeta = this.renderLabelLines(args.labels, '    ');
    const labelLinesPod = this.renderLabelLines(args.labels, '        ');
    const nodeSelectorBlock = args.nodeSelectorHostname
      ? [
          '      nodeSelector:',
          `        kubernetes.io/hostname: ${args.nodeSelectorHostname}`,
        ].join('\n')
      : '';
    const remote = `flui:${args.s3.bucket}/${args.keyPrefix}`;
    return [
      'apiVersion: batch/v1',
      'kind: Job',
      'metadata:',
      `  name: ${args.jobName}`,
      `  namespace: ${args.namespace}`,
      '  labels:',
      labelLinesMeta,
      'spec:',
      '  backoffLimit: 1',
      `  activeDeadlineSeconds: ${COPY_JOB_TIMEOUT_SECONDS}`,
      '  ttlSecondsAfterFinished: 600',
      '  template:',
      '    metadata:',
      '      labels:',
      labelLinesPod,
      '    spec:',
      '      restartPolicy: Never',
      ...(nodeSelectorBlock ? [nodeSelectorBlock] : []),
      '      containers:',
      '        - name: rclone',
      `          image: ${RCLONE_IMAGE}`,
      '          command:',
      '            - /bin/sh',
      '            - -c',
      `            - 'rclone sync "${remote}" /dst'`,
      this.renderS3EnvBlock(args.s3),
      '          volumeMounts:',
      '            - name: dst',
      '              mountPath: /dst',
      '      volumes:',
      '        - name: dst',
      '          persistentVolumeClaim:',
      `            claimName: ${args.destPvcName}`,
      '',
    ].join('\n');
  }

  private renderS3DeleteJobManifest(args: {
    jobName: string;
    namespace: string;
    keyPrefix: string;
    s3: NonNullable<DeleteExportInput['s3']>;
    labels: Record<string, string>;
  }): string {
    const labelLinesMeta = this.renderLabelLines(args.labels, '    ');
    const labelLinesPod = this.renderLabelLines(args.labels, '        ');
    const remote = `flui:${args.s3.bucket}/${args.keyPrefix}`;
    return [
      'apiVersion: batch/v1',
      'kind: Job',
      'metadata:',
      `  name: ${args.jobName}`,
      `  namespace: ${args.namespace}`,
      '  labels:',
      labelLinesMeta,
      'spec:',
      '  backoffLimit: 1',
      `  activeDeadlineSeconds: ${COPY_JOB_TIMEOUT_SECONDS}`,
      '  ttlSecondsAfterFinished: 600',
      '  template:',
      '    metadata:',
      '      labels:',
      labelLinesPod,
      '    spec:',
      '      restartPolicy: Never',
      '      containers:',
      '        - name: rclone',
      `          image: ${RCLONE_IMAGE}`,
      '          command:',
      '            - /bin/sh',
      '            - -c',
      `            - 'rclone purge "${remote}" || rclone delete "${remote}"'`,
      this.renderS3EnvBlock(args.s3),
      '',
    ].join('\n');
  }

  private renderS3EnvBlock(s3: NonNullable<DeleteExportInput['s3']>): string {
    return [
      '          env:',
      '            - name: RCLONE_CONFIG_FLUI_TYPE',
      '              value: "s3"',
      '            - name: RCLONE_CONFIG_FLUI_PROVIDER',
      '              value: "Other"',
      '            - name: RCLONE_CONFIG_FLUI_ACCESS_KEY_ID',
      `              value: ${this.yamlString(s3.accessKeyId)}`,
      '            - name: RCLONE_CONFIG_FLUI_SECRET_ACCESS_KEY',
      `              value: ${this.yamlString(s3.secretAccessKey)}`,
      '            - name: RCLONE_CONFIG_FLUI_ENDPOINT',
      `              value: ${this.yamlString(s3.endpoint)}`,
      '            - name: RCLONE_CONFIG_FLUI_REGION',
      `              value: ${this.yamlString(s3.region || 'auto')}`,
    ].join('\n');
  }

  private renderLabelLines(
    labels: Record<string, string>,
    indent: string,
  ): string {
    return Object.entries(labels)
      .map(([k, v]) => `${indent}${this.yamlString(k)}: ${this.yamlString(v)}`)
      .join('\n');
  }

  private parseStorageGb(value: string): number {
    if (!value) return 0;
    const match = /^(\d+(?:\.\d+)?)([KMGTP]i?)?$/.exec(String(value));
    if (!match) return 0;
    const num = Number.parseFloat(match[1]);
    const unit = match[2];
    switch (unit) {
      case 'Ki':
        return num / (1024 * 1024);
      case 'Mi':
        return num / 1024;
      case 'Gi':
        return num;
      case 'Ti':
        return num * 1024;
      case 'K':
        return num / 1_000_000;
      case 'M':
        return num / 1000;
      case 'G':
        return num;
      case 'T':
        return num * 1000;
      default:
        return num;
    }
  }

  private yamlString(value: string): string {
    return JSON.stringify(value);
  }
}
