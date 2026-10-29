import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { ClusterHaService } from '../../cluster-ha/services/cluster-ha.service';
import { TOPOLOGY_ZONE_LABEL } from '../../providers/core/node-topology';
import { CNPG_API_VERSION } from '../postgres-ha.constants';
import { primaryPlacement } from '../utils/primary-placement.core';

/**
 * Brings the primary of each highly available Postgres back to a location for
 * data after a failover put it in the voting one, where every write of the
 * applications would cross the far link. A planned switchover: writes pause
 * for a few seconds, and no confirmed write is lost.
 */
@Injectable()
export class PrimaryPlacementService {
  private readonly logger = new Logger(PrimaryPlacementService.name);

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly apps: Repository<ApplicationEntity>,
    private readonly kubernetes: KubernetesService,
    private readonly clusterHa: ClusterHaService,
  ) {}

  async sweep(): Promise<void> {
    const active = await this.apps
      .createQueryBuilder('app')
      .where(`app."databaseHa"->>'state' = 'active'`)
      .getMany();
    for (const app of active) {
      await this.check(app).catch((err: any) =>
        this.logger.warn(`[postgres-ha] ${app.slug}: ${err?.message ?? err}`),
      );
    }
  }

  async check(app: ApplicationEntity): Promise<void> {
    const spec = app.databaseHa;
    if (spec?.state !== 'active') return;
    const ha = await this.clusterHa.inspect(app.clusterId);
    if (ha.state.level !== 'three-locations' || !ha.topology) return;
    const namespace = app.k8sNamespace;
    const cluster = await this.kubernetes.readObject(
      ha.kubeconfig,
      CNPG_API_VERSION,
      'Cluster',
      spec.cluster,
      namespace,
    );
    const pods = await this.kubernetes.listPodsByLabel(
      ha.kubeconfig,
      namespace,
      `cnpg.io/cluster=${spec.cluster}`,
    );
    const zoneOf = new Map(
      ha.nodes.map((n) => [
        n.metadata?.name ?? '',
        n.metadata?.labels?.[TOPOLOGY_ZONE_LABEL] ?? '',
      ]),
    );
    const decision = primaryPlacement({
      primary: cluster?.status?.currentPrimary,
      phase: cluster?.status?.phase,
      instances: Number(cluster?.spec?.instances ?? spec.instances),
      readyInstances: Number(cluster?.status?.readyInstances ?? 0),
      pods: pods.map((p) => ({
        name: p.metadata?.name ?? '',
        node: p.spec?.nodeName,
        ready: (p.status?.conditions ?? []).some(
          (c) => c.type === 'Ready' && c.status === 'True',
        ),
      })),
      zoneOf,
      preferredZones: ha.topology.dataZones,
      lastMovedAt: spec.primaryMovedAt,
      now: Date.now(),
    });
    if (!decision.move) return;
    const at = new Date().toISOString();
    await this.kubernetes.jsonPatchObjectStatus(
      ha.kubeconfig,
      {
        apiVersion: CNPG_API_VERSION,
        plural: 'clusters',
        name: spec.cluster,
        namespace,
      },
      [
        {
          op: 'replace',
          path: '/status/targetPrimary',
          value: decision.target,
        },
        { op: 'replace', path: '/status/targetPrimaryTimestamp', value: at },
        {
          op: 'replace',
          path: '/status/phase',
          value: 'Switchover in progress',
        },
        {
          op: 'replace',
          path: '/status/phaseReason',
          value: `Switching over to ${decision.target}`,
        },
      ],
    );
    await this.apps.update(app.id, {
      databaseHa: { ...spec, primaryMovedAt: at },
    });
    this.logger.log(
      `[postgres-ha] ${app.slug}: primary ${cluster?.status?.currentPrimary} sat in the voting location; switching over to ${decision.target}`,
    );
  }
}
