import { Processor, Process } from '@nestjs/bull';
import { dump as dumpYaml } from 'js-yaml';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
  CONTROL_CLUSTER_TYPES,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { BackupJobRepository } from '../repositories/backup-job.repository';
import { BackupPolicyRepository } from '../repositories/backup-policy.repository';
import { BackupDestinationsService } from '../services/backup-destinations.service';
import { TemplateRendererService } from '../services/template-renderer.service';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';
import { BackupPolicyStatus } from '../enums/backup-policy-status.enum';
import {
  BACKUP_QUEUE,
  BACKUP_JOB_TYPES,
  RCLONE_IMAGE,
} from '../backups.constants';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';
import { kopiaBucketPrefix } from '../utils/destination-layout.util';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { BackupArtifactLocationEntity } from '../entities/backup-artifact-location.entity';
import { KopiaReplicationJobData } from '../services/kopia-replication.service';

function isKopiaReplication(data: unknown): data is KopiaReplicationJobData {
  return (data as KopiaReplicationJobData | null)?.mode === 'kopia-repository';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RcloneRemoteCreds {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle?: boolean;
  provider: StorageBackendProvider;
}

/**
 * The rclone configuration the replication job mounts.
 *
 * Built here rather than in the manifest template so the credentials never pass
 * through YAML text at all — see the note at the call site.
 */
function rcloneConf(
  remotes: { src: RcloneRemoteCreds; dst: RcloneRemoteCreds },
  rcloneProvider: (provider: StorageBackendProvider) => string,
): string {
  const section = (name: string, c: RcloneRemoteCreds): string =>
    [
      `[${name}]`,
      'type = s3',
      `provider = ${rcloneProvider(c.provider)}`,
      `endpoint = ${c.endpoint}`,
      `region = ${c.region}`,
      `access_key_id = ${c.accessKey}`,
      `secret_access_key = ${c.secretKey}`,
      `force_path_style = ${String(c.forcePathStyle ?? true)}`,
    ].join('\n');
  return `${section('src', remotes.src)}\n\n${section('dst', remotes.dst)}\n`;
}

@Processor(BACKUP_QUEUE)
export class ReplicateBackupProcessor {
  private readonly logger = new Logger(ReplicateBackupProcessor.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    private readonly artifactRepo: BackupArtifactRepository,
    private readonly destRepo: BackupDestinationRepository,
    private readonly jobRepo: BackupJobRepository,
    private readonly policyRepo: BackupPolicyRepository,
    private readonly destinationsService: BackupDestinationsService,
    private readonly encryption: EncryptionService,
    private readonly k8s: KubernetesService,
    private readonly templates: TemplateRendererService,
  ) {}

  @Process(BACKUP_JOB_TYPES.REPLICATE_BACKUP)
  async handle(job: Job<KopiaReplicationJobData>): Promise<void> {
    if (!isKopiaReplication(job.data)) {
      // Queued by the removed cluster-backup engine before an upgrade.
      this.logger.warn(
        '[replicate-backup] dropped a replication of a retired backup engine',
      );
      return;
    }
    await this.replicateKopiaRepository(job.data);
  }

  /**
   * One application's kopia repository, mirrored to a replica destination.
   *
   * `sync`, not `copy`: kopia's maintenance rewrites and removes blobs, and a
   * replica that only ever gained objects would keep every superseded index
   * beside the current one. Mirroring after a run that just wrote to the
   * source means the source is never empty when it is mirrored.
   */
  private async replicateKopiaRepository(
    data: KopiaReplicationJobData,
  ): Promise<void> {
    this.logger.log(
      `[replicate-backup] kopia repository app=${data.applicationId} src=${data.sourceDestinationId} dst=${data.targetDestinationId}`,
    );
    const setAll = (patch: Partial<BackupArtifactLocationEntity>) =>
      Promise.all(
        data.locationIds.map((id) =>
          this.artifactRepo.updateLocation(id, patch),
        ),
      );
    try {
      const src = await this.destRepo.findById(data.sourceDestinationId);
      const dst = await this.destRepo.findById(data.targetDestinationId);
      if (!src || !dst) throw new Error('Source or target destination missing');
      await setAll({ state: ArtifactLocationState.UPLOADING });
      const ok = await this.runRclone({
        jobId: data.backupJobId,
        src,
        dst,
        srcPrefix: kopiaBucketPrefix(src.pathPrefix, data.applicationId),
        dstPrefix: kopiaBucketPrefix(dst.pathPrefix, data.applicationId),
      });
      if (!ok) throw new Error('rclone replication Job failed');
      await setAll({
        state: ArtifactLocationState.AVAILABLE,
        verifiedAt: new Date(),
      });
      this.logger.log(
        `[replicate-backup] kopia repository of ${data.applicationId} mirrored`,
      );
    } catch (err: any) {
      this.logger.error(
        `[replicate-backup] kopia repository of ${data.applicationId} not mirrored: ${err?.message}`,
      );
      await setAll({
        state: ArtifactLocationState.FAILED,
        lastError: err?.message ?? String(err),
      }).catch(() => undefined);
      const bj = await this.jobRepo.findById(data.backupJobId);
      if (bj?.policyId) {
        await this.policyRepo.update(bj.policyId, {
          status: BackupPolicyStatus.DEGRADED,
        });
      }
    }
  }

  /** Runs one rclone Job on the control cluster between two destinations. */
  private async runRclone(args: {
    jobId: string;
    src: BackupDestinationEntity;
    dst: BackupDestinationEntity;
    srcPrefix: string;
    dstPrefix: string;
  }): Promise<boolean> {
    const obsCluster = await this.clusterRepo.findOne({
      where: {
        clusterType: In([...CONTROL_CLUSTER_TYPES]),
        status: ClusterStatus.READY,
      },
      order: { createdAt: 'DESC' },
    });
    if (!obsCluster) {
      throw new Error(
        'No READY control cluster found — cannot run replication',
      );
    }
    const obsKubeconfig = this.encryption.decrypt(
      obsCluster.kubeconfigEncrypted,
    );

    const srcCreds = this.destinationsService.toCredentials(args.src);
    const dstCreds = this.destinationsService.toCredentials(args.dst);

    const jobName = `flui-replicate-${args.jobId.slice(0, 8)}-${Date.now()}`;
    const secretName = `${jobName}-config`;
    const namespace = 'flui-system';

    // The Secret is built as an object and written by a YAML writer, not
    // substituted into template text: in a `rclone.conf: |` block a newline at
    // the wrong column ends the literal and `\n---\n` starts a new document, so
    // a credential field would apply a manifest of one's choosing into
    // `flui-system`. Charset rules cannot help: an access key is whatever the
    // provider issued.
    const secretYaml = dumpYaml({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: secretName,
        namespace,
        labels: { 'managed-by': 'flui-cloud', 'flui-job-id': args.jobId },
      },
      type: 'Opaque',
      stringData: {
        'rclone.conf': rcloneConf({ src: srcCreds, dst: dstCreds }, (p) =>
          this.rcloneProvider(p),
        ),
      },
    });

    const yaml = this.templates.render('rclone/replication-job.yaml.tpl', {
      SECRET_NAME: secretName,
      NAMESPACE: namespace,
      JOB_NAME: jobName,
      JOB_ID: args.jobId,
      RCLONE_VERB: 'sync',
      RCLONE_IMAGE,
      SRC_BUCKET: srcCreds.bucket,
      SRC_PREFIX: args.srcPrefix,
      DST_BUCKET: dstCreds.bucket,
      DST_PREFIX: args.dstPrefix,
    });

    await this.k8s.applyManifest(
      obsKubeconfig,
      `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${namespace}\n  labels:\n    managed-by: flui-cloud\n`,
    );

    await this.k8s.applyManifest(obsKubeconfig, secretYaml);
    await this.k8s.applyManifest(obsKubeconfig, yaml);

    return this.waitForJob(obsKubeconfig, namespace, jobName);
  }

  private rcloneProvider(p: StorageBackendProvider): string {
    switch (p) {
      case StorageBackendProvider.SCALEWAY_OBJECT_STORAGE:
        return 'Scaleway';
      case StorageBackendProvider.MINIO:
        return 'Minio';
      case StorageBackendProvider.HETZNER_OBJECT_STORAGE:
      case StorageBackendProvider.GENERIC_S3:
      default:
        return 'Other';
    }
  }

  private async waitForJob(
    kubeconfig: string,
    namespace: string,
    name: string,
  ): Promise<boolean> {
    const start = Date.now();
    const timeoutMs = 60 * 60 * 1000;
    const intervalMs = 10_000;
    while (Date.now() - start < timeoutMs) {
      const obj: any = await this.k8s.getResource(
        kubeconfig,
        'Job',
        name,
        namespace,
      );
      const status = obj?.body?.status ?? obj?.status;
      if (status?.succeeded && status.succeeded >= 1) return true;
      if (status?.failed && status.failed >= 3) return false;
      await sleep(intervalMs);
    }
    return false;
  }
}
