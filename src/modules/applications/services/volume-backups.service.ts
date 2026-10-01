import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { VolumeExportFactory } from '../../providers/core/factories/volume-export.factory';
import {
  ExportResult,
  IVolumeExport,
} from '../../providers/interfaces/volume-export.interface';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import {
  VolumeCopyPreflightService,
  describeCopyRisk,
} from './volume-copy-preflight.service';
import { VolumePauseLeaseService } from './volume-pause-lease.service';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { AppResourcesRepository } from '../repositories/app-resources.repository';
import { ApplicationVolumeClaimsService } from './application-volume-claims.service';
import { VolumeCopyLedgerService } from './volume-copy-ledger.service';
import { BackupDestinationEntity } from '../../backups/entities/backup-destination.entity';
import { AppOperationRunner } from './app-operation-runner.service';
import { OperationType } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { exportsRoot } from '../../backups/utils/destination-layout.util';
import { VolumeKopiaSnapshotService } from './volume-kopia-snapshot.service';
import { VolumeBackupDestinationService } from './volume-backup-destination.service';
import {
  BackupResponse,
  CreateBackupForAppRequest,
  DeleteBackupForAppRequest,
  QueuedBackup,
  BackupDestination,
  ResolvedDestination,
  StartedBackup,
} from './volume-backups.types';

export * from './volume-backups.types';

@Injectable()
export class VolumeBackupsService {
  private readonly logger = new Logger(VolumeBackupsService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(BackupDestinationEntity)
    private readonly destinationRepository: Repository<BackupDestinationEntity>,
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly appResourcesRepository: AppResourcesRepository,
    private readonly volumeClaims: ApplicationVolumeClaimsService,
    private readonly copyLedger: VolumeCopyLedgerService,
    private readonly preflight: VolumeCopyPreflightService,
    private readonly pauseLease: VolumePauseLeaseService,
    private readonly volumeExportFactory: VolumeExportFactory,
    private readonly encryptionService: EncryptionService,
    private readonly destinationResolver: VolumeBackupDestinationService,
    private readonly runner: AppOperationRunner,
    private readonly kopiaSnapshots: VolumeKopiaSnapshotService,
    @Optional() @InjectQueue('backup') private readonly queue?: Queue,
  ) {}

  /**
   * A backup asked for by a person, answered with an operation at once.
   *
   * The first snapshot of a large volume can take hours, which no HTTP request
   * should be held open for. What can be refused cheaply is refused here — an
   * unknown volume, several volumes and none named, a destination that does not
   * exist — and the copy itself runs from the queue, reporting into the
   * operation returned now.
   */
  async startForApp(
    request: CreateBackupForAppRequest,
  ): Promise<StartedBackup> {
    if (!this.queue) {
      throw new ServiceUnavailableException(
        'The backup queue is not available',
      );
    }
    const { app, kubeconfig } = await this.resolveAppContext(
      request.applicationId,
    );
    const pvcName = await this.resolvePvcName(
      kubeconfig,
      app,
      request.volumeName,
    );
    if (request.destinationId) {
      const dest = await this.destinationRepository.findOne({
        where: { id: request.destinationId },
      });
      if (!dest) {
        throw new NotFoundException(
          `Backup destination ${request.destinationId} not found`,
        );
      }
    }
    const op = await this.runner.open({
      appId: app.id,
      operationType: OperationType.APP_BACKUP_CREATE,
      resourceName: app.slug,
      userId: request.userId,
      metadata: { pvcName, queued: true },
    });
    const { destination, ...rest } = request;
    const queued: QueuedBackup = {
      request: { ...rest, volumeName: pvcName, operationId: op.id },
      ...(destination
        ? {
            destinationSealed: this.encryptionService.encrypt(
              JSON.stringify(destination),
            ),
          }
        : {}),
    };
    await this.queue.add('app-volume-backup', queued, {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });
    return {
      operationId: op.id,
      applicationId: app.id,
      volumeName: pvcName,
      status: 'pending',
    };
  }

  /** The queued half of `startForApp`. Failures are recorded on the operation. */
  async runQueued(queued: QueuedBackup): Promise<void> {
    const destination = queued.destinationSealed
      ? (JSON.parse(
          this.encryptionService.decrypt(queued.destinationSealed),
        ) as BackupDestination)
      : undefined;
    try {
      await this.createForApp({ ...queued.request, destination });
    } catch (err) {
      // Refusals before the copy started never reached the operation.
      if (queued.request.operationId) {
        await this.runner.failIfPending(queued.request.operationId, err);
      }
      this.logger.warn(
        `[backup] queued backup of ${queued.request.applicationId} failed: ${(err as Error)?.message}`,
      );
    }
  }

  async createForApp(
    request: CreateBackupForAppRequest,
  ): Promise<BackupResponse & { operationId: string }> {
    const { app, cluster, kubeconfig, ops, provider } =
      await this.resolveAppContext(request.applicationId);
    const pvcName = await this.resolvePvcName(
      kubeconfig,
      app,
      request.volumeName,
    );

    const destination = await this.destinationResolver.resolve(
      request.destination,
      request.destinationId,
      provider,
      cluster.id,
      request.userId,
    );

    // A registered destination has a passphrase to derive the repository key
    // from, so its copies are kopia snapshots. A bucket passed as raw
    // credentials or provisioned on the fly has no key, and keeps the
    // full-copy archive it always had.
    if (destination.registered) {
      return this.kopiaSnapshots.create(
        request,
        { app, cluster, kubeconfig, ops, provider },
        pvcName,
        destination as ResolvedDestination & {
          registered: BackupDestinationEntity;
        },
      );
    }

    const keyPrefix = this.buildKeyPrefix(
      exportsRoot(destination.keyPrefix, `flui/${cluster.id}`),
      app.slug,
      request.description,
    );

    const { result, operationId } = await this.runner.run(
      {
        appId: app.id,
        operationType: OperationType.APP_BACKUP_CREATE,
        resourceName: app.slug,
        metadata: { pvcName, bucket: destination.bucket, keyPrefix },
        userId: request.userId,
        operationId: request.operationId,
      },
      async (): Promise<BackupResponse> => {
        const pausedAt = Date.now();
        const { facts, paused } = await this.preflight.check({
          kubeconfig,
          namespace: app.k8sNamespace,
          pvcName,
          allowInconsistent: request.allowInconsistent,
          pause: request.pause,
        });
        const labels: Record<string, string> = {
          'flui.cloud/managed-by': 'flui-cloud',
          'flui-app-id': app.id,
          'flui.cloud/source-pvc': pvcName,
          'flui.cloud/backup-trigger': 'manual',
        };
        let exp: ExportResult;
        try {
          exp = await ops.createExport({
            sink: 's3-archive',
            kubeconfig,
            namespace: app.k8sNamespace,
            sourcePvcName: pvcName,
            exportName: keyPrefix,
            bucket: destination.bucket,
            keyPrefix,
            endpoint: destination.endpoint,
            region: destination.region,
            accessKeyId: destination.accessKeyId,
            secretAccessKey: destination.secretAccessKey,
            labels,
            consistentSqlite: facts.quiesce === 'sqlite-snapshot',
          });
        } finally {
          // Before the ledger write and the S3 bookkeeping on purpose: neither
          // may extend the outage, and a failed copy must still give the app back.
          await this.pauseLease.release(kubeconfig, paused);
        }
        const backReady = paused.length
          ? await this.pauseLease.waitUntilReady(kubeconfig, paused)
          : undefined;
        const interruptionSeconds = paused.length
          ? Math.round((Date.now() - pausedAt) / 1000)
          : undefined;
        this.logger.log(
          `[backup] Archived app=${app.slug} pvc=${pvcName} → s3://${destination.bucket}/${keyPrefix} (size=${exp.sourceSizeGb}GB)`,
        );
        const recorded = await this.copyLedger.record({
          clusterId: cluster.id,
          applicationId: app.id,
          applicationSlug: app.slug,
          volumeName: pvcName,
          userId: request.userId,
          exportId: exp.exportId,
          sink: 's3-archive',
          sizeBytes: exp.actualBytes,
          objectKeyPrefix: keyPrefix,
          bucket: destination.bucket,
          destinationId: request.destinationId,
          policyId: request.policyId,
          expiresAt: request.expiresAt,
          backupJobId: request.backupJobId,
          ...facts,
        });
        return {
          exportId: exp.exportId,
          appId: app.id,
          namespace: exp.namespace,
          sourcePvcName: pvcName,
          sizeGb: exp.sourceSizeGb,
          actualBytes: exp.actualBytes,
          createdAt: exp.createdAt,
          ready: exp.ready,
          destination: {
            bucket: destination.bucket,
            endpoint: destination.endpoint,
            region: destination.region,
            keyPrefix,
          },
          provider,
          providerCapabilities: ops.capabilities,
          encrypted: !!exp.encrypted,
          engine: 'rclone',
          artifactId: recorded?.id,
          warning: describeCopyRisk(facts, exp.writesObservedDuringCopy),
          ...(interruptionSeconds !== undefined
            ? { interruptionSeconds, applicationBack: backReady }
            : {}),
        };
      },
    );
    return { ...result, operationId };
  }

  async deleteForApp(request: DeleteBackupForAppRequest): Promise<void> {
    const { app, kubeconfig, ops } = await this.resolveAppContext(
      request.applicationId,
    );
    await ops.deleteExport({
      kubeconfig,
      sink: 's3-archive',
      namespace: app.k8sNamespace,
      exportId: request.exportId,
      ignoreNotFound: true,
      s3: {
        bucket: request.destination.bucket,
        endpoint: request.destination.endpoint,
        region: request.destination.region,
        accessKeyId: request.destination.accessKeyId,
        secretAccessKey: request.destination.secretAccessKey,
      },
    });
    await this.copyLedger.forget(app.id, request.exportId);
    this.logger.log(
      `[backup] Deleted ${request.exportId} from s3://${request.destination.bucket}`,
    );
  }

  // Listing backups requires scanning S3 — out of scope for this v1; the
  // CLI/UI passes the destination and lists via S3 SDK directly. Kept as a
  // typed stub so consumers can wire the call site today and we plug it in
  // when the listing service ships.
  async listForApp(_applicationId: string): Promise<BackupResponse[]> {
    return [];
  }

  private async resolveAppContext(applicationId: string): Promise<{
    app: {
      id: string;
      slug: string;
      clusterId: string;
      k8sNamespace: string;
      kind?: string;
    };
    cluster: ClusterEntity;
    kubeconfig: string;
    ops: IVolumeExport;
    provider: CloudProvider;
  }> {
    const app = await this.applicationsRepository.findById(applicationId);
    if (!app)
      throw new NotFoundException(`Application ${applicationId} not found`);
    const cluster = await this.clusterRepository.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(
        `Cluster ${app.clusterId} for application ${applicationId} not found`,
      );
    }
    if (!cluster.kubeconfigEncrypted) {
      throw new BadRequestException(
        `Cluster ${cluster.id} has no kubeconfig — cannot operate on backups`,
      );
    }
    const provider = cluster.provider as CloudProvider;
    const ops = this.volumeExportFactory.getOrFail(provider);
    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );
    return {
      app: {
        id: app.id,
        slug: app.slug,
        clusterId: cluster.id,
        k8sNamespace: app.k8sNamespace,
        kind: app.kind,
      },
      cluster,
      kubeconfig,
      ops,
      provider,
    };
  }

  private async resolvePvcName(
    kubeconfig: string,
    app: { id: string; slug: string; k8sNamespace: string },
    explicitName: string | undefined,
  ): Promise<string> {
    // A StatefulSet's volumeClaimTemplates never get a standalone PVC manifest
    // (and so no app_resources row) — resolveForApplication also matches on
    // the <template>-<statefulset>-<ordinal> naming Kubernetes itself mints,
    // which is the only way a database-shaped app's claim is ever found.
    const tracked = await this.appResourcesRepository
      .findByApplicationId(app.id)
      .catch(() => []);
    const claims = await this.volumeClaims.resolveForApplication(
      kubeconfig,
      app,
      tracked,
      // Copies are not volumes to copy: without this, taking one snapshot makes
      // every later "which volume?" ambiguous.
      { excludeCopies: true },
    );
    if (claims.length === 0) {
      throw new BadRequestException(
        `Application ${app.id} has no PersistentVolumeClaim — nothing to back up`,
      );
    }
    if (explicitName) {
      const match = claims.find((c) => c.name === explicitName);
      if (!match) {
        throw new BadRequestException(
          `Volume "${explicitName}" not found on application. Available: ${claims
            .map((c) => c.name)
            .join(', ')}`,
        );
      }
      return match.name;
    }
    if (claims.length > 1) {
      throw new BadRequestException(
        `Application has multiple volumes; specify --volume <name>. Available: ${claims
          .map((c) => c.name)
          .join(', ')}`,
      );
    }
    return claims[0].name;
  }

  private buildKeyPrefix(
    rootPrefix: string,
    slug: string,
    description?: string,
  ): string {
    const ts = new Date().toISOString().replaceAll(/[-:T]/g, '').slice(0, 14);
    const tail = description
      ? `-${description
          .toLowerCase()
          .replaceAll(/[^a-z0-9-]/g, '-')
          .slice(0, 20)}`
      : `-${uuid().slice(0, 6)}`;
    return `${rootPrefix.replace(/\/$/, '')}/${slug}/${ts}${tail}`.replaceAll(
      /-+/g,
      '-',
    );
  }
}
