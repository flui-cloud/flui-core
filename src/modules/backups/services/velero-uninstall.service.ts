import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { In, MoreThan, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../infrastructure/clusters/entities/cluster.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import { BackupArtifactLocationEntity } from '../entities/backup-artifact-location.entity';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { RETIRED_ENGINE_CLASSES } from '../enums/backup-engine-class.enum';
import { BACKUP_JOB_TYPES, BACKUP_QUEUE } from '../backups.constants';
import { trimSlashes } from '../utils/destination-layout.util';
import {
  FLUI_REPOSITORY,
  VELERO_CLUSTER_ROLE_BINDING,
  VELERO_CREDENTIALS,
  VELERO_NAMESPACE,
  VELERO_WORKLOADS,
  VeleroFootprint,
  VeleroLeftBehind,
  VeleroUninstallJobData,
  countVeleroObjects,
  readVeleroOnCluster,
  unreachableClusterState,
} from '../utils/velero-footprint.util';
import {
  releaseVeleroObjects,
  removeIfPresent,
  removeOwnVeleroBinding,
  removeVeleroDefinitions,
  waitForVeleroNamespaceGone,
} from '../utils/velero-removal.util';
import { BackupDestinationsService } from './backup-destinations.service';
import { StorageBackendFactory } from '../../storage/factories/storage-backend.factory';

export { VELERO_KINDS, VELERO_NAMESPACE } from '../utils/velero-footprint.util';
export type {
  VeleroComponent,
  VeleroFootprint,
  VeleroLeftBehind,
  VeleroUninstallJobData,
} from '../utils/velero-footprint.util';

const IN_FLIGHT = [OperationStatus.PENDING, OperationStatus.IN_PROGRESS];
const GONE_CLUSTERS = new Set([ClusterStatus.DELETED, ClusterStatus.LOST]);
/** Longer than any run takes; an older unfinished row was lost with its worker. */
const IN_FLIGHT_WINDOW_MS = 30 * 60 * 1000;

/**
 * Takes the retired cluster-backup engine off a cluster: its controller and
 * node agent, the credentials it held for the bucket, its cluster-admin
 * binding, its resource definitions and its namespace.
 *
 * Only what Flui installed: the namespace must carry Flui's label, and the
 * definitions stay while objects of their kinds exist in any other namespace.
 * The data it wrote stays in the destinations; the footprint says where.
 */
@Injectable()
export class VeleroUninstallService {
  private readonly logger = new Logger(VeleroUninstallService.name);

  constructor(
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly ops: Repository<InfrastructureOperationEntity>,
    @InjectRepository(BackupPolicyEntity)
    private readonly policies: Repository<BackupPolicyEntity>,
    @InjectRepository(BackupArtifactEntity)
    private readonly artifacts: Repository<BackupArtifactEntity>,
    @InjectRepository(BackupArtifactLocationEntity)
    private readonly locations: Repository<BackupArtifactLocationEntity>,
    @InjectRepository(BackupDestinationEntity)
    private readonly destinations: Repository<BackupDestinationEntity>,
    @InjectQueue(BACKUP_QUEUE) private readonly queue: Queue,
    private readonly destinationCreds?: BackupDestinationsService,
    private readonly storage?: StorageBackendFactory,
  ) {}

  async inspect(clusterId: string): Promise<VeleroFootprint> {
    const cluster = await this.liveCluster(clusterId);
    const [pausedPolicies, leftInDestinations, inFlight] = await Promise.all([
      this.retiredPolicies(clusterId),
      this.leftInDestinations(clusterId),
      this.inFlight(clusterId),
    ]);
    const base = {
      clusterId,
      clusterName: cluster.name,
      pausedPolicies,
      leftInDestinations,
      inFlightOperationId: inFlight?.id ?? null,
    };
    const kubeconfig = this.kubeconfigOf(cluster);
    if (!kubeconfig) {
      return { ...base, ...unreachableClusterState() };
    }
    try {
      return { ...base, ...(await readVeleroOnCluster(this.k8s, kubeconfig)) };
    } catch (err: any) {
      this.logger.warn(
        `[velero-uninstall] cluster ${clusterId} not readable: ${err?.message}`,
      );
      return { ...base, ...unreachableClusterState() };
    }
  }

  /** Starts the removal, or returns the one already running on this cluster. */
  async start(
    userId: string,
    clusterId: string,
  ): Promise<{ operationId: string; alreadyRunning: boolean }> {
    const cluster = await this.liveCluster(clusterId);
    if (!this.kubeconfigOf(cluster)) {
      throw new BadRequestException(
        `Cluster ${cluster.name} has no access configuration, so nothing can be removed from it.`,
      );
    }
    const running = await this.inFlight(clusterId);
    if (running) return { operationId: running.id, alreadyRunning: true };

    const op = await this.ops.save(
      this.ops.create({
        operationType: OperationType.UNINSTALL_VELERO,
        status: OperationStatus.PENDING,
        resourceType: 'cluster',
        resourceId: clusterId,
        resourceName: cluster.name,
        userId,
        metadata: { clusterId },
        totalSteps: 5,
      }),
    );
    const data: VeleroUninstallJobData = { clusterId, operationId: op.id };
    await this.queue.add(BACKUP_JOB_TYPES.UNINSTALL_VELERO, data, {
      attempts: 1,
      removeOnComplete: true,
    });
    return { operationId: op.id, alreadyRunning: false };
  }

  /** The removal itself. Every step tolerates what an earlier run already did. */
  async run(data: VeleroUninstallJobData): Promise<void> {
    const { clusterId, operationId } = data;
    const step = (currentStep: OperationStep, progress: number) =>
      this.ops.update(operationId, {
        status: OperationStatus.IN_PROGRESS,
        currentStep,
        progress,
      });
    await this.ops.update(operationId, {
      status: OperationStatus.IN_PROGRESS,
      currentStep: OperationStep.VELERO_UNINSTALL_INSPECT,
      startedAt: new Date(),
      progress: 5,
    });
    try {
      const cluster = await this.liveCluster(clusterId);
      const kubeconfig = this.kubeconfigOf(cluster);
      if (!kubeconfig)
        throw new Error('The cluster has no access configuration.');

      const before = await readVeleroOnCluster(this.k8s, kubeconfig);
      if (!before.installedByFlui) {
        throw new Error(
          `The "${VELERO_NAMESPACE}" namespace on this cluster was not created by Flui; nothing was removed.`,
        );
      }
      const removed: string[] = [];

      await step(OperationStep.VELERO_UNINSTALL_STOP, 20);
      for (const w of VELERO_WORKLOADS) {
        if (await removeIfPresent(this.k8s, kubeconfig, w, VELERO_NAMESPACE)) {
          removed.push(`${w.kind}/${w.name}`);
        }
      }

      await step(OperationStep.VELERO_UNINSTALL_RELEASE, 40);
      if (
        await removeIfPresent(
          this.k8s,
          kubeconfig,
          VELERO_CREDENTIALS,
          VELERO_NAMESPACE,
        )
      ) {
        removed.push(`${VELERO_CREDENTIALS.kind}/${VELERO_CREDENTIALS.name}`);
      }
      if (await removeOwnVeleroBinding(this.k8s, kubeconfig)) {
        removed.push(
          `${VELERO_CLUSTER_ROLE_BINDING.kind}/${VELERO_CLUSTER_ROLE_BINDING.name}`,
        );
      }
      const released = await releaseVeleroObjects(
        this.k8s,
        kubeconfig,
        this.logger,
      );

      await step(OperationStep.VELERO_UNINSTALL_REMOVE, 60);
      const elsewhere = await countVeleroObjects(
        this.k8s,
        kubeconfig,
        'elsewhere',
      );
      if (elsewhere === 0) {
        removed.push(...(await removeVeleroDefinitions(this.k8s, kubeconfig)));
      }
      if (before.namespace === 'present') {
        await this.k8s.deleteNamespace(kubeconfig, VELERO_NAMESPACE);
        removed.push(`Namespace/${VELERO_NAMESPACE}`);
      }

      await step(OperationStep.VELERO_UNINSTALL_VERIFY, 85);
      await waitForVeleroNamespaceGone(this.k8s, kubeconfig);
      const after = await readVeleroOnCluster(this.k8s, kubeconfig);

      const kept =
        elsewhere > 0
          ? [
              `resource definitions kept: ${elsewhere} object(s) of their kinds exist outside the "${VELERO_NAMESPACE}" namespace`,
            ]
          : [];

      await this.ops.update(operationId, {
        status: OperationStatus.COMPLETED,
        progress: 100,
        completedAt: new Date(),
        metadata: {
          clusterId,
          removed,
          released,
          kept,
          stillPresent: after.components
            .filter((c) => c.present)
            .map((c) => `${c.kind}/${c.name}`),
          leftInDestinations: await this.leftInDestinations(clusterId),
        } as never,
      });
      this.logger.log(
        `[velero-uninstall] cluster ${clusterId}: removed ${removed.length} object(s), released ${released}`,
      );
    } catch (err: any) {
      const message = err?.message ?? String(err);
      this.logger.error(`[velero-uninstall] cluster ${clusterId}: ${message}`);
      await this.ops.update(operationId, {
        status: OperationStatus.FAILED,
        errorMessage: message,
        completedAt: new Date(),
      });
    }
  }

  private async retiredPolicies(
    clusterId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const rows = await this.policies.find({
      where: {
        clusterId,
        engineClass: In([...RETIRED_ENGINE_CLASSES]) as never,
      },
      select: { id: true, name: true },
    });
    return rows.map((p) => ({ id: p.id, name: p.name }));
  }

  private async leftInDestinations(
    clusterId: string,
  ): Promise<VeleroLeftBehind[]> {
    const artifacts = await this.artifacts.find({
      where: {
        clusterId,
        engineClass: In([...RETIRED_ENGINE_CLASSES]) as never,
      },
      select: { id: true },
    });
    if (artifacts.length === 0) return [];
    const locations = await this.locations.find({
      where: { artifactId: In(artifacts.map((a) => a.id)) },
    });
    const byDestination = new Map<
      string,
      { backups: number; engineFolder: boolean }
    >();
    for (const loc of locations) {
      if (!loc.destinationId) continue;
      const entry = byDestination.get(loc.destinationId) ?? {
        backups: 0,
        engineFolder: false,
      };
      entry.backups++;
      if ((loc.objectKeyPrefix ?? '').startsWith('velero/')) {
        entry.engineFolder = true;
      }
      byDestination.set(loc.destinationId, entry);
    }
    if (byDestination.size === 0) return [];
    const dests = await this.destinations.find({
      where: { id: In([...byDestination.keys()]) },
    });
    const byId = new Map(dests.map((d) => [d.id, d]));
    return Promise.all(
      [...byDestination.entries()].map(async ([id, entry]) => {
        const dest = byId.get(id);
        const root = trimSlashes(dest?.pathPrefix);
        const folder = entry.engineFolder ? 'velero/' : 'backups/';
        return {
          destinationId: id,
          destinationName: dest?.name ?? null,
          bucket: dest?.bucket ?? null,
          prefix: root ? `${root}/${folder}` : folder,
          backups: entry.backups,
          volumeData: dest ? await this.volumeDataIn(dest, root) : [],
        };
      }),
    );
  }

  private async volumeDataIn(
    dest: BackupDestinationEntity,
    root: string,
  ): Promise<VeleroLeftBehind['volumeData']> {
    if (!this.destinationCreds || !this.storage) return [];
    try {
      const creds = this.destinationCreds.toCredentials(dest);
      const backend = this.storage.forProvider(dest.provider);
      const base = root ? `${root}/kopia/` : 'kopia/';
      const folders = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await backend.listObjects(creds, 'kopia/', cursor);
        for (const key of page.keys) {
          const folder = key
            .slice(key.indexOf(base) + base.length)
            .split('/')[0];
          if (folder && !FLUI_REPOSITORY.test(folder)) folders.add(folder);
        }
        cursor = page.hasMore ? page.continuationToken : undefined;
      } while (cursor);
      const out: VeleroLeftBehind['volumeData'] = [];
      for (const folder of [...folders].sort((a, b) => a.localeCompare(b))) {
        const usage = await backend.getUsage(creds, `kopia/${folder}/`);
        out.push({ prefix: `${base}${folder}/`, bytes: usage.bytes });
      }
      return out;
    } catch (error) {
      this.logger.warn(
        `Could not list what Velero left in ${dest.name}: ${error instanceof Error ? error.message : error}`,
      );
      return [];
    }
  }

  private async inFlight(
    clusterId: string,
  ): Promise<InfrastructureOperationEntity | null> {
    return this.ops.findOne({
      where: {
        operationType: OperationType.UNINSTALL_VELERO,
        resourceId: clusterId,
        status: In(IN_FLIGHT),
        createdAt: MoreThan(new Date(Date.now() - IN_FLIGHT_WINDOW_MS)),
      },
      order: { createdAt: 'DESC' },
    });
  }

  private async liveCluster(clusterId: string): Promise<ClusterEntity> {
    const cluster = await this.clusters.findOne({ where: { id: clusterId } });
    if (!cluster || GONE_CLUSTERS.has(cluster.status)) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }
    return cluster;
  }

  private kubeconfigOf(cluster: ClusterEntity): string | null {
    if (!cluster.kubeconfigEncrypted) return null;
    return this.encryption.decrypt(cluster.kubeconfigEncrypted);
  }
}
