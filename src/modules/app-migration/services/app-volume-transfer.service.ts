import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationResourceKind } from '../../applications/enums/application-resource-kind.enum';
import { ApplicationMaterializerService } from '../../applications/services/application-materializer.service';
import {
  ApplicationVolumeClaim,
  ApplicationVolumeClaimsService,
} from '../../applications/services/application-volume-claims.service';
import { DedicatedPlacementService } from '../../applications/services/dedicated-placement.service';
import { VolumeBackupRestoreService } from '../../applications/services/volume-backup-restore.service';
import { VolumeBackupsService } from '../../applications/services/volume-backups.service';
import { BackupDestinationEntity } from '../../backups/entities/backup-destination.entity';
import { BackupPolicyEntity } from '../../backups/entities/backup-policy.entity';

export interface VolumeTransferPlan {
  destinationId: string;
  dedicatedNodeName?: string;
}

/**
 * Carries an application's volumes to another cluster through a backup
 * destination: a kopia snapshot on the source, restored into the claim the
 * workload will use on the destination. The repository is the application's
 * own, so a snapshot taken while it still runs makes the one taken after it
 * stops incremental, and the stop lasts only as long as the last changes take.
 */
@Injectable()
export class AppVolumeTransferService {
  private readonly logger = new Logger(AppVolumeTransferService.name);

  constructor(
    @InjectRepository(BackupPolicyEntity)
    private readonly policyRepo: Repository<BackupPolicyEntity>,
    @InjectRepository(BackupDestinationEntity)
    private readonly destinationRepo: Repository<BackupDestinationEntity>,
    private readonly volumeBackups: VolumeBackupsService,
    private readonly restore: VolumeBackupRestoreService,
    private readonly claims: ApplicationVolumeClaimsService,
    private readonly materializer: ApplicationMaterializerService,
    private readonly placement: DedicatedPlacementService,
  ) {}

  hasVolumes(app: ApplicationEntity): boolean {
    return !!app.volumes?.length;
  }

  async plan(
    app: ApplicationEntity,
    userId: string,
    targetClusterId: string,
    requestedDestinationId?: string,
  ): Promise<VolumeTransferPlan> {
    return {
      destinationId: await this.destinationFor(
        app,
        userId,
        requestedDestinationId,
      ),
      dedicatedNodeName: await this.destinationNode(app, targetClusterId),
    };
  }

  /** Taken while the source still serves, so the copy at cutover moves only what changed since. */
  async warm(
    app: ApplicationEntity,
    plan: VolumeTransferPlan,
    userId: string,
  ): Promise<void> {
    for (const claim of await this.sourceClaims(app)) {
      try {
        await this.volumeBackups.createForApp({
          applicationId: app.id,
          volumeName: claim.name,
          destinationId: plan.destinationId,
          userId,
          description: 'move',
        });
      } catch (err) {
        this.logger.log(
          `[app-migration] ${app.slug}/${claim.name}: no copy ahead of the move (${(err as Error).message}); the whole volume moves at cutover`,
        );
      }
    }
  }

  /** The source must be stopped: what is copied here is what the destination starts from. */
  async copy(
    app: ApplicationEntity,
    plan: VolumeTransferPlan,
    userId: string,
    targetClusterId: string,
  ): Promise<void> {
    const kubeconfig = await this.materializer.kubeconfigOf(targetClusterId);
    for (const claim of await this.sourceClaims(app)) {
      const backup = await this.volumeBackups.createForApp({
        applicationId: app.id,
        volumeName: claim.name,
        destinationId: plan.destinationId,
        userId,
        description: 'move',
      });
      if (!backup.artifactId) {
        throw new Error(
          `The copy of ${claim.name} was not recorded, so it cannot be restored on the destination`,
        );
      }
      await this.restore.restoreIntoClaim({
        applicationId: app.id,
        artifactId: backup.artifactId,
        kubeconfig,
        namespace: app.k8sNamespace,
        claimName: claim.name,
        nodeName: plan.dedicatedNodeName,
        createWith: {
          storageClassName: claim.storageClass ?? 'local-path',
          sizeGb: claim.requestedBytes / 1024 ** 3,
        },
      });
      this.logger.log(
        `[app-migration] ${app.slug}/${claim.name}: restored on cluster ${targetClusterId}`,
      );
    }
  }

  private async sourceClaims(
    app: ApplicationEntity,
  ): Promise<ApplicationVolumeClaim[]> {
    const kubeconfig = await this.materializer.kubeconfigOf(app.clusterId);
    return this.claims.resolveForApplication(
      kubeconfig,
      app,
      app.workloadKind === 'StatefulSet'
        ? [{ kind: ApplicationResourceKind.STATEFUL_SET, name: app.slug }]
        : [],
      { excludeCopies: true },
    );
  }

  private async destinationFor(
    app: ApplicationEntity,
    userId: string,
    requested?: string,
  ): Promise<string> {
    if (requested) {
      const dest = await this.destinationRepo.findOne({
        where: { id: requested },
      });
      if (!dest) {
        throw new BadRequestException(
          `Backup destination ${requested} not found`,
        );
      }
      return dest.id;
    }

    const policies = await this.policyRepo.find({
      where: { clusterId: app.clusterId, enabled: true },
      relations: ['destinations'],
    });
    const primary = policies
      .filter((p) => p.scopeSelector?.applicationIds?.includes(app.id))
      .flatMap((p) => p.destinations ?? [])
      .find((d) => d.role === 'primary');
    if (primary) return primary.destinationId;

    const own = await this.destinationRepo.find({ where: { userId } });
    if (own.length === 1) return own[0].id;
    throw new BadRequestException({
      code: 'MIGRATION_NEEDS_BACKUP_DESTINATION',
      message: own.length
        ? `${app.slug} has volumes, and they move through a backup destination. You have ${own.length}: name the one to use.`
        : `${app.slug} has volumes, and they move through a backup destination. None is registered: add one with \`flui backup destination create\`, then move it again.`,
    });
  }

  private async destinationNode(
    app: ApplicationEntity,
    targetClusterId: string,
  ): Promise<string | undefined> {
    if (app.persistenceScope !== 'dedicated') return undefined;
    const node = await this.placement.selectBestWorker({
      ...app,
      clusterId: targetClusterId,
      dedicatedNodeName: undefined,
    } as ApplicationEntity);
    if (node) return node;
    if (app.allowMasterPlacement) return undefined;
    throw new BadRequestException({
      code: 'NO_WORKER_FOR_DEDICATED_APP',
      message: `${app.slug} keeps its data on one node, and the destination cluster has no worker to give it.`,
    });
  }
}
