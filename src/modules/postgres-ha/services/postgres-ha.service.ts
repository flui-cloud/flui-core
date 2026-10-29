import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { TOPOLOGY_ZONE_LABEL } from '../../providers/core/node-topology';
import { ActivateDatabaseHaDto } from '../dto/activate-database-ha.dto';
import {
  CNPG_API_VERSION,
  POSTGRES_HA_JOB_ACTIVATE,
  POSTGRES_HA_QUEUE,
} from '../postgres-ha.constants';
import { DatabaseHaSpec } from '../postgres-ha.types';
import { ClusterHaService } from '../../cluster-ha/services/cluster-ha.service';
import { postgresHaEligibility } from '../utils/postgres-ha-eligibility.core';
import {
  DatabaseHaPlacement,
  REPLICATION_SQL,
  databaseHaPlacement,
} from '../utils/database-ha-placement.core';
import { BackupPolicyEntity } from '../../backups/entities/backup-policy.entity';
import { BackupEngineClass } from '../../backups/enums/backup-engine-class.enum';
import { BackupScope } from '../../backups/enums/backup-scope.enum';
import {
  haCandidatesFrom,
  postgresHaFeasibility,
} from '../utils/postgres-ha-feasibility.core';

/** One per location of the layout. */
export const HA_INSTANCES = 3;

export interface ActivateDatabaseHaJob {
  operationId: string;
  appId: string;
  durability: 'required' | 'preferred';
  preferredZones: string[];
}

export interface DatabaseHaView {
  appId: string;
  highlyAvailable: boolean;
  state: DatabaseHaSpec | null;
  /** Read live while highly available; null when the cluster did not answer. */
  placement: DatabaseHaPlacement | null;
}

@Injectable()
export class PostgresHaService {
  private readonly logger = new Logger(PostgresHaService.name);

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly apps: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operations: Repository<InfrastructureOperationEntity>,
    @InjectRepository(BackupPolicyEntity)
    private readonly backupPolicies: Repository<BackupPolicyEntity>,
    @InjectQueue(POSTGRES_HA_QUEUE) private readonly queue: Queue,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
    private readonly clusterHa: ClusterHaService,
  ) {}

  async view(appId: string): Promise<DatabaseHaView> {
    const app = await this.apps.findOne({ where: { id: appId } });
    if (!app) throw new NotFoundException(`Application ${appId} not found`);
    const stopped =
      app.databaseHa?.state === 'copying' &&
      !(await this.activationRunning(appId));
    return {
      appId,
      highlyAvailable: app.databaseHa?.state === 'active',
      state: stopped
        ? {
            ...app.databaseHa!,
            state: 'failed',
            detail: 'it did not finish, and can be started again.',
          }
        : (app.databaseHa ?? null),
      placement:
        app.databaseHa?.state === 'active'
          ? await this.placement(app, app.databaseHa).catch((err: any) => {
              this.logger.warn(
                `[postgres-ha] ${app.slug}: placement not read (${err?.message ?? err})`,
              );
              return null;
            })
          : null,
    };
  }

  private async placement(
    app: ApplicationEntity,
    spec: DatabaseHaSpec,
  ): Promise<DatabaseHaPlacement | null> {
    const cluster = await this.clusters.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) return null;
    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
    const [object, pods, nodes] = await Promise.all([
      this.kubernetes.readObject(
        kubeconfig,
        CNPG_API_VERSION,
        'Cluster',
        spec.cluster,
        app.k8sNamespace,
      ),
      this.kubernetes.listPodsByLabel(
        kubeconfig,
        app.k8sNamespace,
        `cnpg.io/cluster=${spec.cluster}`,
      ),
      this.kubernetes.listNodes(kubeconfig),
    ]);
    const primary: string | undefined = object?.status?.currentPrimary;
    const replication = primary
      ? await this.kubernetes.execInPod(
          kubeconfig,
          app.k8sNamespace,
          '',
          'postgres',
          ['psql', '-U', 'postgres', '-Atc', REPLICATION_SQL],
          primary,
        )
      : '';
    return databaseHaPlacement({
      primary,
      pods: pods.map((p) => ({
        name: p.metadata?.name ?? '',
        node: p.spec?.nodeName,
        ready: (p.status?.conditions ?? []).some(
          (c) => c.type === 'Ready' && c.status === 'True',
        ),
      })),
      zoneOf: new Map(
        nodes.map((n) => [
          n.metadata?.name ?? '',
          n.metadata?.labels?.[TOPOLOGY_ZONE_LABEL] ?? '',
        ]),
      ),
      replication,
      now: new Date(),
    });
  }

  private async activationRunning(appId: string): Promise<boolean> {
    const running = await this.operations.count({
      where: {
        operationType: OperationType.ACTIVATE_DATABASE_HA,
        resourceId: appId,
        status: In([OperationStatus.PENDING, OperationStatus.IN_PROGRESS]),
      },
    });
    return running > 0;
  }

  /** An enabled database policy that names this application, its namespace or its whole cluster. */
  private async hasContinuousBackups(app: ApplicationEntity): Promise<boolean> {
    const policies = await this.backupPolicies.find({
      where: {
        clusterId: app.clusterId,
        engineClass: BackupEngineClass.DATABASE,
        enabled: true,
      },
    });
    return policies.some((p) => {
      if (p.scope === BackupScope.CLUSTER_ALL) return true;
      if (p.scope === BackupScope.APPLICATIONS) {
        return p.scopeSelector?.applicationIds?.includes(app.id) ?? false;
      }
      if (p.scope === BackupScope.NAMESPACES) {
        return p.scopeSelector?.namespaces?.includes(app.k8sNamespace) ?? false;
      }
      return false;
    });
  }

  /**
   * Checks what can be checked before anything moves, so a request the cluster
   * cannot honour is refused with its reason, then hands the move to the queue.
   */
  async activate(
    appId: string,
    dto: ActivateDatabaseHaDto,
    userId?: string,
  ): Promise<{ operationId: string; durability: string }> {
    const app = await this.apps.findOne({ where: { id: appId } });
    if (!app) throw new NotFoundException(`Application ${appId} not found`);
    const eligibility = postgresHaEligibility(
      app,
      await this.activationRunning(appId),
    );
    if (!eligibility.eligible)
      throw new BadRequestException((eligibility as { reason: string }).reason);
    if (await this.hasContinuousBackups(app)) {
      throw new BadRequestException(
        'This database has continuous backups, and a highly available database cannot take them yet: after the move they would stop. Pause its backup policy first, knowing it will be unprotected, or wait until highly available databases are backed up.',
      );
    }

    const ha = await this.clusterHa.requireThreeLocations(
      app.clusterId,
      dto.force,
    );
    const durability = dto.durability ?? 'required';
    const feasibility = postgresHaFeasibility(
      haCandidatesFrom(ha.nodes),
      ha.topology,
    );
    if (!feasibility.feasible)
      throw new BadRequestException((feasibility as { reason: string }).reason);

    const operation = await this.operations.save(
      this.operations.create({
        operationType: OperationType.ACTIVATE_DATABASE_HA,
        status: OperationStatus.PENDING,
        resourceType: 'application',
        resourceId: appId,
        resourceName: app.slug,
        userId,
        metadata: {
          durability,
          zones: ha.topology.zones,
          ...(!ha.topology.validated && { forced: true }),
        },
        totalSteps: 5,
      }),
    );
    const job: ActivateDatabaseHaJob = {
      operationId: operation.id,
      appId,
      durability,
      preferredZones: ha.topology.dataZones,
    };
    await this.queue.add(POSTGRES_HA_JOB_ACTIVATE, job, { attempts: 1 });
    this.logger.log(
      `[postgres-ha] ${app.slug}: activation queued (${durability}, ${ha.topology.zones.join(', ')})`,
    );
    return { operationId: operation.id, durability };
  }
}
