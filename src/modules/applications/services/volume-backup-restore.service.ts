import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BackupArtifactEntity } from '../../backups/entities/backup-artifact.entity';
import { BackupEngineClass } from '../../backups/enums/backup-engine-class.enum';
import { BackupDestinationsService } from '../../backups/services/backup-destinations.service';
import { KopiaCliService } from '../../backups/services/kopia-cli.service';
import { kopiaLocation } from '../../backups/utils/kopia-repository.util';
import {
  kopiaJobName,
  kopiaRepositoryLabel,
} from '../../backups/utils/kopia-job.manifest';
import {
  BackupFileEntry,
  VolumeBackupView,
  mergeBackupListings,
  normalizeBackupPath,
  normalizeRestorePaths,
  primaryLocationOf,
  toVolumeBackupView,
  volumeRestoreRoute,
} from '../../backups/utils/kopia-restore.util';
import { restorePasswords } from '../../backups/utils/rclone-crypt.util';
import { VolumeExportService } from '../../providers/services/volume-export.service';
import { OperationType } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { AppOperationRunner } from './app-operation-runner.service';
import { KopiaVolumeEngineService } from './kopia-volume-engine.service';
import { replacesLabel } from './spare-volumes.service';
import { VolumeBackupLookupService } from './volume-backup-lookup.service';

export interface VolumeBackupRestoreRequest {
  /** Another application to restore into; the backup's own when omitted. */
  targetApplicationId?: string;
  /** The target's volume the restored copy is meant to replace. */
  volumeName?: string;
}

export interface VolumeBackupRestoreResult {
  operationId: string;
  engine: 'kopia' | 'rclone';
  targetApplicationId: string;
  newPvcName: string;
  /** The volume to swap the new copy in for, when the target has one. */
  replaces: string | null;
}

export interface VolumeFilesRestoreRequest {
  paths: string[];
  /** Restore under this directory of the volume instead of over the originals. */
  targetDirectory?: string;
  targetApplicationId?: string;
  volumeName?: string;
}

/**
 * Reading a volume backup back: list them, look inside a kopia snapshot,
 * restore a whole volume beside an application or single paths into one.
 *
 * A whole restore never touches the running application: it lands in a new
 * volume, and making the application use it is the existing swap. Single
 * paths are written into the application's volume, over the originals unless
 * a target directory keeps them apart.
 */
@Injectable()
export class VolumeBackupRestoreService {
  private readonly logger = new Logger(VolumeBackupRestoreService.name);

  constructor(
    @InjectRepository(BackupArtifactEntity)
    private readonly artifactRepo: Repository<BackupArtifactEntity>,
    private readonly applications: ApplicationsRepository,
    private readonly destinations: BackupDestinationsService,
    private readonly kopiaCli: KopiaCliService,
    private readonly kopia: KopiaVolumeEngineService,
    private readonly volumeExport: VolumeExportService,
    private readonly runner: AppOperationRunner,
    private readonly lookup: VolumeBackupLookupService,
  ) {}

  async list(applicationId: string): Promise<VolumeBackupView[]> {
    const rows = await this.artifactRepo.find({
      where: {
        applicationId,
        engineClass: BackupEngineClass.VOLUME_COPY,
      },
      relations: ['locations'],
      order: { createdAt: 'DESC' },
      take: 200,
    });
    const now = new Date();
    return rows.map((a) => toVolumeBackupView(a, now));
  }

  async browse(
    applicationId: string,
    artifactId: string,
    path?: string,
  ): Promise<{
    backupId: string;
    path: string;
    isFile: boolean;
    entries: BackupFileEntry[];
  }> {
    const artifact = await this.lookup.artifactOf(applicationId, artifactId);
    const record = this.lookup.kopiaRecord(artifact);
    const access = await this.lookup.repositoryAccess(artifact);
    const normalized = normalizeBackupPath(path);
    const roots = [
      record.rootObject,
      ...(record.sqlite ? [record.sqlite.rootObject] : []),
    ];
    const [primary, overlay] = await this.kopiaCli.listDirectories(
      access,
      roots,
      normalized,
    );
    if (!primary.found && !overlay?.found) {
      throw new NotFoundException(`"${normalized}" is not in this backup`);
    }
    const isFile = primary.isFile || !!overlay?.isFile;
    return {
      backupId: artifact.id,
      path: normalized,
      isFile,
      entries: mergeBackupListings(
        primary.found ? primary.entries : [],
        overlay?.found ? overlay.entries : [],
      ),
    };
  }

  async restore(
    applicationId: string,
    artifactId: string,
    request: VolumeBackupRestoreRequest,
    user?: AuthenticatedUser,
  ): Promise<VolumeBackupRestoreResult> {
    const artifact = await this.lookup.artifactOf(applicationId, artifactId);
    const route = volumeRestoreRoute(artifact);
    if (route.kind === 'pvc-clone') {
      throw new BadRequestException(
        'This copy is a volume on the cluster: restore it with `flui app snapshot restore`.',
      );
    }
    if (route.kind === 'unavailable')
      throw new BadRequestException(route.reason);

    const target = await this.lookup.targetContext(
      applicationId,
      request.targetApplicationId,
      user,
    );
    const claim = await this.lookup.targetClaim(
      target,
      request.volumeName ??
        (target.app.id === applicationId ? artifact.volumeName : undefined),
      false,
    );
    const location = primaryLocationOf(artifact);
    const dest = await this.lookup.destinationOf(location?.destinationId);
    const sizeGb = Math.max(
      Number(artifact.manifestSummary?.sourceSizeGb) || 0,
      claim ? claim.requestedBytes / 1024 ** 3 : 0,
      1,
    );
    const node = claim
      ? (
          await this.kopia.sourceVolume(
            target.kubeconfig,
            target.app.k8sNamespace,
            claim.name,
          )
        ).nodeName
      : undefined;
    const ts = new Date().toISOString().replaceAll(/[-:T]/g, '').slice(0, 14);
    const newPvcName = `${(claim?.name ?? artifact.volumeName ?? target.app.slug).slice(0, 44)}-restored-${ts}`;
    const labels = {
      'flui.cloud/managed-by': 'flui-cloud',
      'flui-app-id': target.app.id,
      'flui.cloud/restored-from': artifact.id,
      ...replacesLabel(claim?.name),
    };

    const { operationId } = await this.runner.run(
      {
        appId: target.app.id,
        operationType: OperationType.APP_SNAPSHOT_RESTORE,
        resourceName: target.app.slug,
        userId: user?.userId,
        metadata: {
          backupId: artifact.id,
          fromApplicationId: applicationId,
          newPvcName,
          engine: route.kind === 'kopia' ? 'kopia' : 'rclone',
        },
      },
      async () => {
        if (route.kind === 'kopia') {
          await this.kopia.createVolume({
            kubeconfig: target.kubeconfig,
            namespace: target.app.k8sNamespace,
            name: newPvcName,
            storageClassName: claim?.storageClass ?? 'local-path',
            sizeGb,
            labels,
          });
          await this.kopia.restore({
            kubeconfig: target.kubeconfig,
            repositoryKey: kopiaRepositoryLabel(
              dest.id,
              artifact.applicationId!,
            ),
            credentials: await this.lookup.kopiaCredentials(artifact, dest),
            job: {
              jobName: kopiaJobName('restore', `${artifact.id}/${newPvcName}`),
              namespace: target.app.k8sNamespace,
              repositoryAppId: artifact.applicationId!,
              location: kopiaLocation(dest, artifact.applicationId!),
              targetPvcName: newPvcName,
              primarySnapshotId: route.record.snapshotId,
              sqliteSnapshotId: route.record.sqlite?.snapshotId,
              nodeName: node,
              sizeGb,
              labels,
            },
          });
        } else {
          const creds = this.destinations.toCredentials(dest);
          await this.volumeExport.restoreFromExport({
            kubeconfig: target.kubeconfig,
            namespace: target.app.k8sNamespace,
            exportId: route.objectKeyPrefix,
            sink: 's3-archive',
            newPvcName,
            storageClassName: claim?.storageClass ?? 'local-path',
            sizeGb: Math.ceil(sizeGb),
            preferredNode: node,
            labels,
            s3: {
              bucket: creds.bucket,
              endpoint: creds.endpoint,
              region: creds.region,
              accessKeyId: creds.accessKey,
              secretAccessKey: creds.secretKey,
            },
            ...(route.encrypted
              ? {
                  encryption: restorePasswords(
                    this.destinations.decryptPassphrase(dest),
                    dest.name,
                  ),
                }
              : {}),
          });
        }
        this.logger.log(
          `[restore] backup ${artifact.id} → ${target.app.slug}/${newPvcName}`,
        );
        return { newPvcName };
      },
    );
    return {
      operationId,
      engine: route.kind === 'kopia' ? 'kopia' : 'rclone',
      targetApplicationId: target.app.id,
      newPvcName,
      replaces: claim?.name ?? null,
    };
  }

  /**
   * Restore a kopia snapshot whole into a claim that already exists, on any
   * cluster. Moving an application uses it: the destination claim is empty and
   * nothing mounts it yet, so the data goes straight where the workload will
   * look for it, with no swap afterwards.
   */
  async restoreIntoClaim(args: {
    applicationId: string;
    artifactId: string;
    kubeconfig: string;
    namespace: string;
    claimName: string;
    nodeName?: string;
    /** Create the claim first when it does not exist, for a workload that only claims it once it runs. */
    createWith?: { storageClassName: string; sizeGb: number };
  }): Promise<{ bytes?: number }> {
    const artifact = await this.lookup.artifactOf(
      args.applicationId,
      args.artifactId,
    );
    const route = volumeRestoreRoute(artifact);
    if (route.kind !== 'kopia') {
      throw new BadRequestException(
        route.kind === 'unavailable'
          ? route.reason
          : 'Only a kopia snapshot can be restored into an existing volume',
      );
    }
    const dest = await this.lookup.destinationOf(
      primaryLocationOf(artifact)?.destinationId,
    );
    const sizeGb = Math.max(
      Number(artifact.manifestSummary?.sourceSizeGb) || 0,
      1,
    );
    const labels = {
      'flui.cloud/managed-by': 'flui-cloud',
      'flui-app-id': args.applicationId,
      'flui.cloud/restored-from': artifact.id,
    };
    const exists = await this.kopia
      .sourceVolume(args.kubeconfig, args.namespace, args.claimName)
      .then(() => true)
      .catch(() => false);
    if (args.createWith && !exists) {
      await this.kopia.createVolume({
        kubeconfig: args.kubeconfig,
        namespace: args.namespace,
        name: args.claimName,
        storageClassName: args.createWith.storageClassName,
        sizeGb: Math.max(sizeGb, args.createWith.sizeGb),
        labels: {
          'flui.cloud/managed-by': 'flui-cloud',
          'flui-app-id': args.applicationId,
        },
      });
    }
    return this.kopia.restore({
      kubeconfig: args.kubeconfig,
      repositoryKey: kopiaRepositoryLabel(dest.id, artifact.applicationId!),
      credentials: await this.lookup.kopiaCredentials(artifact, dest),
      job: {
        jobName: kopiaJobName('restore', `${artifact.id}/${args.claimName}`),
        namespace: args.namespace,
        repositoryAppId: artifact.applicationId!,
        location: kopiaLocation(dest, artifact.applicationId!),
        targetPvcName: args.claimName,
        primarySnapshotId: route.record.snapshotId,
        sqliteSnapshotId: route.record.sqlite?.snapshotId,
        nodeName: args.nodeName,
        sizeGb,
        labels,
      },
    });
  }

  async restoreFiles(
    applicationId: string,
    artifactId: string,
    request: VolumeFilesRestoreRequest,
    user?: AuthenticatedUser,
  ): Promise<{
    operationId: string;
    targetApplicationId: string;
    volumeName: string;
    paths: string[];
    targetDirectory: string | null;
  }> {
    const artifact = await this.lookup.artifactOf(applicationId, artifactId);
    const record = this.lookup.kopiaRecord(artifact);
    let paths: string[];
    let targetDirectory: string;
    try {
      paths = normalizeRestorePaths(request.paths);
      targetDirectory = normalizeBackupPath(request.targetDirectory);
    } catch (err: any) {
      throw new BadRequestException(err?.message ?? String(err));
    }
    const target = await this.lookup.targetContext(
      applicationId,
      request.targetApplicationId,
      user,
    );
    const claim = (await this.lookup.targetClaim(
      target,
      request.volumeName ??
        (target.app.id === applicationId ? artifact.volumeName : undefined),
      true,
    ))!;
    const dest = await this.lookup.destinationOf(
      primaryLocationOf(artifact)?.destinationId,
    );
    const volume = await this.kopia.sourceVolume(
      target.kubeconfig,
      target.app.k8sNamespace,
      claim.name,
    );

    const { operationId } = await this.runner.run(
      {
        appId: target.app.id,
        operationType: OperationType.APP_SNAPSHOT_RESTORE,
        resourceName: target.app.slug,
        userId: user?.userId,
        metadata: {
          backupId: artifact.id,
          volumeName: claim.name,
          paths: paths.slice(0, 20),
          targetDirectory: targetDirectory || null,
          engine: 'kopia',
        },
      },
      async () => {
        const out = await this.kopia.restore({
          kubeconfig: target.kubeconfig,
          repositoryKey: kopiaRepositoryLabel(dest.id, artifact.applicationId!),
          credentials: await this.lookup.kopiaCredentials(artifact, dest),
          job: {
            jobName: kopiaJobName(
              'restore',
              `${artifact.id}/${claim.name}/${Date.now()}`,
            ),
            namespace: target.app.k8sNamespace,
            repositoryAppId: artifact.applicationId!,
            location: kopiaLocation(dest, artifact.applicationId!),
            targetPvcName: claim.name,
            primarySnapshotId: record.snapshotId,
            sqliteSnapshotId: record.sqlite?.snapshotId,
            paths,
            targetDirectory: targetDirectory || undefined,
            nodeName: volume.nodeName,
            sizeGb: volume.sizeGb,
            labels: {
              'flui.cloud/managed-by': 'flui-cloud',
              'flui-app-id': target.app.id,
            },
          },
        });
        return out;
      },
    );
    return {
      operationId,
      targetApplicationId: target.app.id,
      volumeName: claim.name,
      paths,
      targetDirectory: targetDirectory || null,
    };
  }

  /**
   * Removes one volume backup: the kopia snapshot, or the archive's objects,
   * then its row. A clone on the cluster is removed with `app snapshot delete`.
   */
  async remove(
    applicationId: string,
    artifactId: string,
    user?: AuthenticatedUser,
  ): Promise<{ operationId: string }> {
    const artifact = await this.lookup.artifactOf(applicationId, artifactId);
    const route = volumeRestoreRoute(artifact);
    if (route.kind === 'pvc-clone') {
      throw new BadRequestException(
        'This copy is a volume on the cluster: remove it with `flui app snapshot delete`.',
      );
    }
    const app = await this.applications.findById(applicationId);
    const { operationId } = await this.runner.run(
      {
        appId: applicationId,
        operationType: OperationType.APP_SNAPSHOT_DELETE,
        resourceName: app?.slug ?? applicationId,
        userId: user?.userId,
        metadata: { backupId: artifact.id },
      },
      async () => {
        const location = primaryLocationOf(artifact);
        if (route.kind === 'kopia') {
          const dest = await this.lookup.destinationOf(location?.destinationId);
          await this.kopiaCli.deleteSnapshots(
            await this.lookup.repositoryAccess(artifact, dest),
            [
              route.record.snapshotId,
              ...(route.record.sqlite ? [route.record.sqlite.snapshotId] : []),
            ],
          );
        } else if (route.kind === 's3-archive' && location?.destinationId) {
          const dest = await this.lookup.destinationOf(location.destinationId);
          await this.lookup.deleteArchive(dest, route.objectKeyPrefix);
        }
        await this.lookup.forgetArtifact(artifact);
      },
    );
    return { operationId };
  }
}
