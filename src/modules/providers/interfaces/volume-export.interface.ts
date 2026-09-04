/**
 * Provider-side volume export primitive.
 *
 * One operation — `createExport` — moves data out of a live PVC into a sink.
 * Two sink kinds are supported:
 *
 *   - `pvc-clone`   : sink is a fresh PVC in the same cluster (snapshot use case)
 *   - `s3-archive`  : sink is an object-store bucket (backup / DR use case)
 *
 * Both are realised today via the universal copy-pod pattern (a Job that
 * mounts source + target and streams data). Provider implementations may
 * specialize a sink in the future (e.g. native CSI VolumeSnapshot when we
 * eventually move PVCs off `local-path` onto a real CSI driver) without
 * changing this contract.
 *
 * The user-facing surfaces ("snapshots", "backups") are thin services on
 * top of this primitive — see VolumeSnapshotsService and VolumeBackupsService
 * in the applications module.
 */

export type ExportSinkKind = 'pvc-clone' | 's3-archive';

export interface VolumeExportCapabilities {
  /**
   * True when retaining many exports is cheap (incremental / dedup-friendly).
   * Today both providers go through copy-pod, so `pvc-clone` retention is
   * always full-volume billed. `s3-archive` via restic gets dedup for free.
   */
  pvcCloneSupportsCheapRetention: boolean;
  s3ArchiveSupportsCheapRetention: boolean;

  /**
   * Approximate price for retaining an export, in EUR per GB per month.
   * For pvc-clone this is the volume rate; for s3-archive this is the
   * bucket rate (provider- and class-dependent).
   */
  pvcClonePricePerGbMonthEur: number | null;
  s3ArchivePricePerGbMonthEur: number | null;
}

interface ExportInputBase {
  /** Kubeconfig of the workload cluster where the source PVC lives. */
  kubeconfig: string;
  /** Namespace of the source PVC. */
  namespace: string;
  /** Source PVC name. */
  sourcePvcName: string;
  /** Logical export name (cluster-unique within the chosen sink space). */
  exportName: string;
  /**
   * Labels applied to every Flui-managed resource the export materialises
   * (the sink PVC, the copy Job, the S3 object metadata, …). Always
   * populated by Flui with `flui.cloud/managed-by=flui-cloud`,
   * `flui-app-id=<id>`, and a sink discriminator so the reaper can
   * identify orphans.
   */
  labels: Record<string, string>;
}

export interface PvcCloneExportInput extends ExportInputBase {
  sink: 'pvc-clone';
  /** Storage class for the destination PVC. Defaults to the source's. */
  destStorageClass?: string;
}

export interface S3ArchiveExportInput extends ExportInputBase {
  sink: 's3-archive';
  /** Destination bucket. Caller resolves credentials separately. */
  bucket: string;
  /** Object key prefix inside the bucket (e.g. `flui/<cluster>/<app>/<ts>/`). */
  keyPrefix: string;
  /** S3 endpoint URL (compatible with AWS, MinIO, R2, B2, …). */
  endpoint: string;
  /** Region. Empty string OK for non-AWS endpoints. */
  region: string;
  /** Access credentials. Read by the copy-pod via env vars only. */
  accessKeyId: string;
  secretAccessKey: string;
}

export type CreateExportInput = PvcCloneExportInput | S3ArchiveExportInput;

export interface ExportResult {
  /** Stable identifier of the export resource. For pvc-clone: clone PVC name. For s3-archive: full s3 URI of the manifest object. */
  exportId: string;
  /** Sink kind, mirrors the input. */
  sink: ExportSinkKind;
  /** Namespace of the source PVC (and of the clone PVC for pvc-clone). */
  namespace: string;
  /** Source PVC declared size in GB (spec.resources.requests.storage). */
  sourceSizeGb: number;
  /**
   * Actual bytes written by the copy-pod / uploaded to S3, measured live
   * during the export run. Reflects real on-disk / on-bucket usage —
   * typically much smaller than `sourceSizeGb * 1e9`.
   */
  actualBytes?: number;
  /**
   * Whether the copy tool reported the source changing under it.
   *
   * `true` is proof the copy is torn — and it is not otherwise visible, since
   * the copy retries and then reports success. `false` means the log was read
   * and said nothing. Undefined where the sink cannot tell (the tar sink emits
   * no such warning), which is not the same as `false`.
   */
  writesObservedDuringCopy?: boolean;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** Provider-side ready state — true once the export can be restored from. */
  ready: boolean;
}

export interface ListExportsInput {
  kubeconfig: string;
  /** Restrict to one sink kind. When omitted, all kinds are returned. */
  sink?: ExportSinkKind;
  namespace?: string;
  /** Optional label selector (e.g. `flui-app-id=<id>`). */
  labelSelector?: string;
}

export interface ExportSummary {
  exportId: string;
  sink: ExportSinkKind;
  namespace: string;
  sourcePvcName?: string;
  appId?: string;
  /** Source PVC declared size in GB (spec.resources.requests.storage). */
  sizeGb?: number;
  /** Actual on-disk / on-bucket bytes when known. */
  actualBytes?: number;
  createdAt: string;
  ready: boolean;
  labels: Record<string, string>;
}

export interface DeleteExportInput {
  kubeconfig: string;
  namespace: string;
  exportId: string;
  sink: ExportSinkKind;
  ignoreNotFound?: boolean;
  /**
   * For s3-archive deletes: same S3 credentials needed to issue the
   * DeleteObject calls. Caller resolves separately. Ignored for pvc-clone.
   */
  s3?: {
    bucket: string;
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
}

export interface RestorePvcFromExportInput {
  kubeconfig: string;
  namespace: string;
  exportId: string;
  sink: ExportSinkKind;
  /** Desired name of the new PVC. */
  newPvcName: string;
  /** Storage class for the new PVC. */
  storageClassName: string;
  /** Storage size for the new PVC (must be >= source size). */
  sizeGb: number;
  /** Optional node hint. */
  preferredNode?: string;
  /** Labels applied to the new PVC. */
  labels: Record<string, string>;
  /** Same shape as DeleteExportInput.s3, only required for sink=s3-archive. */
  s3?: DeleteExportInput['s3'];
}

export interface IVolumeExport {
  readonly capabilities: VolumeExportCapabilities;

  createExport(input: CreateExportInput): Promise<ExportResult>;
  listExports(input: ListExportsInput): Promise<ExportSummary[]>;
  deleteExport(input: DeleteExportInput): Promise<void>;
  restoreFromExport(
    input: RestorePvcFromExportInput,
  ): Promise<{ pvcName: string }>;
}
