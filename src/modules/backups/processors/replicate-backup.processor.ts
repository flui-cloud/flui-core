import { Processor, Process } from '@nestjs/bull';
import { dump as dumpYaml } from 'js-yaml';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterType,
  ClusterStatus,
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
import { BackupJobStatus } from '../enums/backup-job.enum';
import {
  BACKUP_QUEUE,
  BACKUP_JOB_TYPES,
  RCLONE_IMAGE,
} from '../backups.constants';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';

export interface ReplicateBackupJobData {
  artifactId: string;
  locationId: string;
  sourceDestinationId: string;
  targetDestinationId: string;
  veleroBackupName: string;
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
  async handle(job: Job<ReplicateBackupJobData>): Promise<void> {
    const {
      artifactId,
      locationId,
      sourceDestinationId,
      targetDestinationId,
      veleroBackupName,
    } = job.data;
    this.logger.log(
      `[replicate-backup] artifact=${artifactId} src=${sourceDestinationId} dst=${targetDestinationId}`,
    );

    try {
      const obsCluster = await this.clusterRepo.findOne({
        where: {
          clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
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

      const src = await this.destRepo.findById(sourceDestinationId);
      const dst = await this.destRepo.findById(targetDestinationId);
      if (!src || !dst) throw new Error('Source or target destination missing');

      const srcCreds = this.destinationsService.toCredentials(src);
      const dstCreds = this.destinationsService.toCredentials(dst);

      await this.artifactRepo.updateLocation(locationId, {
        state: ArtifactLocationState.UPLOADING,
      });

      const jobName = `flui-replicate-${artifactId.slice(0, 8)}-${Date.now()}`;
      const secretName = `${jobName}-config`;
      const namespace = 'flui-system';

      // The Secret is built as an object and written by a YAML writer, not
      // substituted into template text.
      //
      // It used to be the first document of that template, with the two access
      // keys and both endpoints dropped straight into an `rclone.conf: |` block.
      // A newline at the wrong column ends a literal block, and `\n---\n` after
      // it starts a new document — so a credential field was a way to apply a
      // manifest of one's choosing into `flui-system`. Charset rules cannot help
      // here: an access key is whatever the provider issued.
      const secretYaml = dumpYaml({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: secretName,
          namespace,
          labels: { 'managed-by': 'flui-cloud', 'flui-job-id': artifactId },
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
        JOB_ID: artifactId,
        RCLONE_IMAGE,
        SRC_BUCKET: srcCreds.bucket,
        SRC_PREFIX: this.normalizePrefix(srcCreds.pathPrefix, veleroBackupName),
        DST_BUCKET: dstCreds.bucket,
        DST_PREFIX: this.normalizePrefix(dstCreds.pathPrefix, veleroBackupName),
      });

      // Ensure namespace exists in obs cluster
      await this.k8s.applyManifest(
        obsKubeconfig,
        `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${namespace}\n  labels:\n    managed-by: flui-cloud\n`,
      );

      await this.k8s.applyManifest(obsKubeconfig, secretYaml);
      await this.k8s.applyManifest(obsKubeconfig, yaml);

      // Wait for Job
      const ok = await this.waitForJob(obsKubeconfig, namespace, jobName);
      if (!ok) {
        throw new Error('rclone replication Job failed');
      }

      await this.artifactRepo.updateLocation(locationId, {
        state: ArtifactLocationState.AVAILABLE,
        verifiedAt: new Date(),
      });

      // After all replicas resolved, mark job COMPLETED if no more PENDING
      const artifact = await this.artifactRepo.findArtifact(artifactId);
      if (artifact) {
        const stillPending = artifact.locations.some(
          (l) =>
            l.state === ArtifactLocationState.PENDING ||
            l.state === ArtifactLocationState.UPLOADING,
        );
        if (!stillPending) {
          const anyFailed = artifact.locations.some(
            (l) => l.state === ArtifactLocationState.FAILED,
          );
          await this.jobRepo.update(artifact.backupJobId, {
            status: anyFailed
              ? BackupJobStatus.PARTIALLY_COMPLETED
              : BackupJobStatus.COMPLETED,
            finishedAt: new Date(),
          });
        }
      }

      this.logger.log(`[replicate-backup] Completed location=${locationId}`);
    } catch (err: any) {
      this.logger.error(`[replicate-backup] Failed: ${err?.message}`);
      await this.artifactRepo.updateLocation(locationId, {
        state: ArtifactLocationState.FAILED,
        lastError: err?.message ?? String(err),
      });
      // Mark policy DEGRADED
      const artifact = await this.artifactRepo.findArtifact(
        job.data.artifactId,
      );
      if (artifact?.backupJobId) {
        const bj = await this.jobRepo.findById(artifact.backupJobId);
        if (bj?.policyId) {
          await this.policyRepo.update(bj.policyId, {
            status: BackupPolicyStatus.DEGRADED,
          });
        }
      }
      // Don't throw — degraded mode is not job-level failure
    }
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

  private normalizePrefix(
    pathPrefix: string | undefined,
    name: string,
  ): string {
    const base = (pathPrefix ?? '').replaceAll(/^\/+|\/+$/g, '');
    const tail = `backups/${name}/`;
    return base ? `${base}/${tail}` : tail;
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
