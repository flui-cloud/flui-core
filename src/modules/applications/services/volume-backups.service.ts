import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { VolumeExportFactory } from '../../providers/core/factories/volume-export.factory';
import {
  ExportResult,
  IVolumeExport,
  VolumeExportCapabilities,
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
import { ObjectStorageProvisionerFactory } from '../../storage/factories/object-storage-provisioner.factory';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';
import { AppOperationRunner } from './app-operation-runner.service';
import { OperationType } from '../../infrastructure/servers/entities/infrastructure-operations.entity';

export interface BackupDestination {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional override; defaults to flui/<cluster>/<app>/<timestamp>/. */
  keyPrefix?: string;
}

export interface CreateBackupForAppRequest {
  applicationId: string;
  /** Optional PVC name. If omitted and the app has exactly one PVC, that one is used. */
  volumeName?: string;
  /** Optional human-friendly suffix appended to the generated key prefix. */
  description?: string;
  /**
   * Explicit destination. When omitted the service auto-provisions a bucket
   * via the cluster provider's object-storage provisioner (Scaleway: full
   * auto, Hetzner: requires Object Storage credentials connected).
   */
  destination?: BackupDestination;
  /**
   * A registered backup destination to archive into. Preferred over passing
   * raw credentials: the copy is then linked to that destination in the ledger,
   * so it can be listed, previewed and restored like any other backup.
   */
  destinationId?: string;
  /**
   * Required when destination is auto-provisioned (the user owns the bucket
   * naming/billing scope).
   */
  userId?: string;
  /** Copy a volume that holds a live database anyway. */
  allowInconsistent?: boolean;
  /** Stop the writers, copy at rest, then start them again. */
  pause?: boolean;
  /** The policy that scheduled this copy, when one did. */
  policyId?: string;
  /** When retention says this copy stops being kept. */
  expiresAt?: Date;
}

export interface BackupResponse {
  exportId: string;
  appId: string;
  namespace: string;
  sourcePvcName: string;
  sizeGb: number;
  actualBytes?: number;
  createdAt: string;
  ready: boolean;
  destination: Omit<BackupDestination, 'accessKeyId' | 'secretAccessKey'>;
  provider: CloudProvider;
  providerCapabilities: VolumeExportCapabilities;
  /** Set only when there is something true to say about this copy. */
  warning?: string;
}

export interface DeleteBackupForAppRequest {
  applicationId: string;
  exportId: string;
  destination: BackupDestination;
}

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
    private readonly objectStorageProvisionerFactory: ObjectStorageProvisionerFactory,
    private readonly runner: AppOperationRunner,
  ) {}

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

    const destination = await this.resolveDestination(
      request.destination,
      request.destinationId,
      provider,
      cluster.id,
      request.userId,
    );

    const keyPrefix = this.buildKeyPrefix(
      destination.keyPrefix ?? `flui/${cluster.id}`,
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
      },
      async (): Promise<BackupResponse> => {
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
          });
        } finally {
          // Before the ledger write and the S3 bookkeeping on purpose: neither
          // may extend the outage, and a failed copy must still give the app back.
          await this.pauseLease.release(kubeconfig, paused);
        }
        this.logger.log(
          `[backup] Archived app=${app.slug} pvc=${pvcName} → s3://${destination.bucket}/${keyPrefix} (size=${exp.sourceSizeGb}GB)`,
        );
        await this.copyLedger.record({
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
          warning: describeCopyRisk(facts, exp.writesObservedDuringCopy),
        };
      },
    );
    return { ...result, operationId };
  }

  /**
   * If the caller passed an explicit destination, use it. Otherwise auto-
   * provision via the matching object-storage provisioner. This requires
   * the cluster provider's compute credentials to be configured (Scaleway:
   * the same key powers Object Storage; Hetzner: separate Object Storage
   * key required).
   */
  private async resolveDestination(
    explicit: BackupDestination | undefined,
    destinationId: string | undefined,
    cloudProvider: CloudProvider,
    clusterId: string,
    userId: string | undefined,
  ): Promise<BackupDestination> {
    if (explicit) return explicit;

    // A registered destination is the good path: its credentials are already
    // encrypted at rest, and the copy ends up linked to it in the ledger
    // instead of pointing at a bucket nothing else knows about.
    if (destinationId) {
      const dest = await this.destinationRepository.findOne({
        where: { id: destinationId },
      });
      if (!dest) {
        throw new NotFoundException(
          `Backup destination ${destinationId} not found`,
        );
      }
      return {
        bucket: dest.bucket,
        endpoint: dest.endpoint,
        region: dest.region,
        accessKeyId: this.encryptionService.decrypt(dest.accessKeyEncrypted),
        secretAccessKey: this.encryptionService.decrypt(
          dest.secretKeyEncrypted,
        ),
        keyPrefix: dest.pathPrefix,
      };
    }

    const storageProvider = this.cloudToStorageProvider(cloudProvider);
    if (!storageProvider) {
      throw new BadRequestException(
        `No object-storage provisioner available for provider=${cloudProvider}; ` +
          `pass an explicit destination instead`,
      );
    }
    const provisioner =
      this.objectStorageProvisionerFactory.forProvider(storageProvider);
    if (!provisioner) {
      throw new BadRequestException(
        `Object-storage provisioner not registered for ${storageProvider}; ` +
          `pass an explicit destination instead`,
      );
    }
    if (!userId) {
      throw new BadRequestException(
        'userId is required to auto-provision a backup destination',
      );
    }
    const readiness = await provisioner.isReady(userId);
    if (!readiness.ready) {
      throw new BadRequestException(
        readiness.message ??
          `Object-storage provisioner not ready (${readiness.reason ?? 'unknown'})`,
      );
    }
    const result = await provisioner.provisionDestination({
      userId,
      clusterId,
    });
    return {
      bucket: result.bucket,
      endpoint: result.endpoint,
      region: result.region,
      accessKeyId: result.accessKey,
      secretAccessKey: result.secretKey,
      keyPrefix: result.pathPrefix,
    };
  }

  private cloudToStorageProvider(
    cloudProvider: CloudProvider,
  ): StorageBackendProvider | null {
    switch (cloudProvider) {
      case CloudProvider.SCALEWAY:
        return StorageBackendProvider.SCALEWAY_OBJECT_STORAGE;
      case CloudProvider.HETZNER:
        return StorageBackendProvider.HETZNER_OBJECT_STORAGE;
      default:
        return null;
    }
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
