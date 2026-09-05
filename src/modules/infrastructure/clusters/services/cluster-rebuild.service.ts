import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
} from '../entities/cluster.entity';
import { ApplicationEntity } from '../../../applications/entities/application.entity';
import { ApplicationStatus } from '../../../applications/enums/application-status.enum';
import { AppEndpointEntity } from '../../../dns/entities/app-endpoint.entity';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';

/** One application's place in a rebuild, and everything true about it. */
export interface RebuildPlanApp {
  applicationId: string;
  name: string;
  slug: string;
  status: string;
  /** Set when this application cannot be rebuilt at all. */
  blocked?: string;
  /** True but not disqualifying — the user decides. */
  warnings: string[];
  /** Where it got to on a previous run, when there was one. */
  phase?: string;
}

export interface RebuildPlan {
  from: { id: string; name: string; status: string };
  to: { id: string; name: string; status: string };
  apps: RebuildPlanApp[];
  /** Reasons the whole rebuild cannot start. Empty means it can. */
  refusals: string[];
  capacity?: {
    requiredCpuMillis: number;
    requiredMemoryMi: number;
    availableCpuMillis: number;
    availableMemoryMi: number;
    fits: boolean;
  };
}

/**
 * Re-materialises the applications of a lost cluster onto a live one.
 *
 * The records are the source: `ApplicationEntity` carries env, volumes, config,
 * resources, scaling, exposure and placement, and the manifest generator
 * rebuilds every Kubernetes object from that row — which is what a redeploy
 * already does. Backups supply the *contents*; the records supply the shape.
 *
 * Three declared limits: it covers only what Flui created, it rebuilds the
 * container and not what is inside it, and it needs a live control plane.
 */
@Injectable()
export class ClusterRebuildService {
  private readonly logger = new Logger(ClusterRebuildService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(AppEndpointEntity)
    private readonly endpointRepo: Repository<AppEndpointEntity>,
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
  ) {}

  async plan(fromId: string, toId: string): Promise<RebuildPlan> {
    const from = await this.mustFindCluster(fromId, 'from');
    const to = await this.mustFindCluster(toId, 'to');
    const refusals: string[] = [];

    if (from.id === to.id) {
      refusals.push('A cluster cannot be rebuilt onto itself.');
    }
    if (to.clusterType === ClusterType.CONTROL) {
      refusals.push(
        'The control cluster runs the plane doing the rebuilding, and is not a ' +
          'destination for workloads.',
      );
    }
    if (to.status !== ClusterStatus.READY) {
      refusals.push(
        `The destination is ${to.status}, not ready. Applications can only be ` +
          'rebuilt onto a cluster that can accept them.',
      );
    }

    // A source that still answers is not lost, and moving a live cluster is a
    // migration: it drains rather than rebuilds, and the two must not be
    // confused by a command that assumes nothing is running.
    if (await this.isReachable(from)) {
      refusals.push(
        `${from.name} is still reachable. A rebuild re-materialises what was ` +
          'lost; moving a working cluster is a migration, which drains it ' +
          'instead of recreating from records.',
      );
    }

    const apps = await this.appRepo.find({
      where: { clusterId: from.id },
      order: { name: 'ASC' },
    });
    const planned = apps.map((app) => this.planApp(app));

    const capacity = await this.planCapacity(to, apps).catch((err: Error) => {
      refusals.push(
        `The destination's capacity could not be read (${err.message}), so the ` +
          'whole set cannot be checked against it before starting.',
      );
      return undefined;
    });
    if (capacity && !capacity.fits) {
      refusals.push(
        `The destination does not have room for all ${apps.length} applications ` +
          `(needs ${capacity.requiredCpuMillis}m CPU and ${capacity.requiredMemoryMi}Mi, ` +
          `has ${capacity.availableCpuMillis}m and ${capacity.availableMemoryMi}Mi). ` +
          'Checked for the whole set, because a rebuild that fits app by app and ' +
          'runs out halfway leaves half a cluster.',
      );
    }

    return {
      from: { id: from.id, name: from.name, status: from.status },
      to: { id: to.id, name: to.name, status: to.status },
      apps: planned,
      refusals,
      capacity,
    };
  }

  /**
   * What is true about one application, separated into what stops it and what
   * the person needs to know before saying yes.
   */
  private planApp(app: ApplicationEntity): RebuildPlanApp {
    const warnings: string[] = [];
    let blocked: string | undefined;

    // A node name from the lost cluster names a machine the destination does
    // not have. Left in place it becomes a nodeSelector nothing satisfies, and
    // the pod waits forever instead of failing.
    if (app.dedicatedNodeName) {
      blocked =
        `pinned to node "${app.dedicatedNodeName}", which does not exist on the ` +
        'destination';
    }

    if (app.status !== ApplicationStatus.RUNNING) {
      warnings.push(
        `was ${app.status}, not running, when the cluster was lost — skipped ` +
          'unless asked for',
      );
    }
    if ((app.volumes ?? []).length > 0) {
      warnings.push(
        'has volumes: it comes back with the data of its last copy, or empty if ' +
          'there is none',
      );
    }

    return {
      applicationId: app.id,
      name: app.name,
      slug: app.slug,
      status: app.status,
      blocked,
      warnings,
      phase: (app.metadata as Record<string, string> | undefined)?.rebuildPhase,
    };
  }

  /**
   * Summed for the whole set, never app by app.
   *
   * Checking one at a time answers a different question: each may fit while
   * the set does not, and the rebuild discovers it halfway through, with some
   * applications moved and some not.
   */
  private async planCapacity(
    to: ClusterEntity,
    apps: ApplicationEntity[],
  ): Promise<RebuildPlan['capacity']> {
    if (!to.kubeconfigEncrypted) {
      throw new Error('the destination has no kubeconfig');
    }
    const allocatable = await this.k8s.getNodeAllocatable(
      this.encryption.decrypt(to.kubeconfigEncrypted),
    );

    let cpu = 0;
    let memory = 0;
    for (const app of apps) {
      const r = app.resources as
        | { cpu?: { request?: string }; memory?: { limit?: string } }
        | undefined;
      cpu += parseCpuMillis(r?.cpu?.request) * (app.replicas ?? 1);
      memory += parseMemoryMi(r?.memory?.limit) * (app.replicas ?? 1);
    }

    const availableCpuMillis = Math.round(allocatable.cpu * 1000);
    const availableMemoryMi = Math.round(allocatable.memory / (1024 * 1024));
    return {
      requiredCpuMillis: cpu,
      requiredMemoryMi: memory,
      availableCpuMillis,
      availableMemoryMi,
      fits: cpu <= availableCpuMillis && memory <= availableMemoryMi,
    };
  }

  /**
   * Does the source still answer?
   *
   * Deliberately a call that throws. `listResourcesByLabel` answers `[]` for an
   * unreachable cluster as readily as for an empty one, and reading that as
   * "lost" would let a rebuild run against a cluster that is merely busy.
   */
  private async isReachable(cluster: ClusterEntity): Promise<boolean> {
    if (!cluster.kubeconfigEncrypted) return false;
    try {
      await this.k8s.getNodeAllocatable(
        this.encryption.decrypt(cluster.kubeconfigEncrypted),
      );
      return true;
    } catch {
      return false;
    }
  }

  private async mustFindCluster(
    id: string,
    side: 'from' | 'to',
  ): Promise<ClusterEntity> {
    const cluster = await this.clusterRepo.findOne({ where: { id } });
    if (!cluster) {
      throw new BadRequestException(`No cluster ${id} for --${side}`);
    }
    return cluster;
  }
}

function parseCpuMillis(value?: string): number {
  if (!value) return 0;
  return value.endsWith('m')
    ? Number.parseInt(value, 10)
    : Math.round(Number.parseFloat(value) * 1000);
}

function parseMemoryMi(value?: string): number {
  if (!value) return 0;
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti)?$/.exec(value.trim());
  if (!m) return 0;
  const n = Number.parseFloat(m[1]);
  switch (m[2]) {
    case 'Ki':
      return Math.round(n / 1024);
    case 'Gi':
      return Math.round(n * 1024);
    case 'Ti':
      return Math.round(n * 1024 * 1024);
    default:
      return Math.round(n);
  }
}
