import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { SchedulerLeadershipService } from '../../common/leadership/scheduler-leadership.service';
import { ApplicationEntity } from '../entities/application.entity';
import { rangeOf } from '../services/app-autoscaling.service';
import {
  PLATFORM_API,
  maxApiReplicas,
  planApiSizing,
} from './platform-api-sizing';

const { namespace: NAMESPACE, name: NAME } = PLATFORM_API;

/**
 * Keeps the API at the size this installation chose for it.
 *
 * The choice lives on the API's own application, where `flui app scale` and
 * the dashboard already write it. A platform update or a K3s restart applies
 * the manifest again, which puts the template's single copy and its limits
 * back; the leader puts the installation's choice back on top, once.
 */
@Injectable()
export class PlatformApiSizingScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlatformApiSizingScheduler.name);
  private running = false;

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
    private readonly leadership: SchedulerLeadershipService,
  ) {}

  onApplicationBootstrap(): void {
    this.leadership.onChange((leader) => {
      if (leader) void this.reconcile();
    });
  }

  @Cron('*/2 * * * *')
  async reconcile(): Promise<void> {
    if (this.running || !this.leadership.isLeader()) return;
    // A developer's API pointed at an installation must not resize it.
    if (!process.env.KUBERNETES_SERVICE_HOST) return;
    this.running = true;
    try {
      await this.reconcileOnce();
    } catch (error) {
      this.logger.warn(
        `Could not bring the API to its chosen size: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async reconcileOnce(): Promise<void> {
    const app = await this.applications.findOne({
      where: { slug: NAME, k8sNamespace: NAMESPACE, deletedAt: IsNull() },
    });
    if (!app?.clusterId) return;
    const control = await this.clusters.findOne({
      where: { id: app.clusterId, status: ClusterStatus.READY },
      select: { id: true, kubeconfigEncrypted: true },
    });
    if (!control?.kubeconfigEncrypted) return;
    const kubeconfig = this.encryption.decrypt(control.kubeconfigEncrypted);

    const deployment = await this.kubernetes.readObject(
      kubeconfig,
      'apps/v1',
      'Deployment',
      NAME,
      NAMESPACE,
    );
    const container = deployment?.spec?.template?.spec?.containers?.find(
      (c: { name: string }) => c.name === NAME,
    );
    if (!deployment || !container) return;

    const plan = planApiSizing(
      {
        replicas: app.replicas,
        resources: app.resources,
        autoscaled: rangeOf(app.scaling).enabled,
      },
      {
        replicas: deployment.spec?.replicas ?? 1,
        requests: container.resources?.requests ?? {},
        limits: container.resources?.limits ?? {},
      },
      maxApiReplicas(),
    );
    if (plan.refused) {
      this.logger.warn(`Left the API as it is: ${plan.refused}`);
      return;
    }
    if (plan.resources) {
      await this.kubernetes.patchWorkloadContainerResources(
        kubeconfig,
        'Deployment',
        NAMESPACE,
        NAME,
        NAME,
        plan.resources,
      );
      this.logger.log(
        `Put back the API resources this installation chose: ${JSON.stringify(plan.resources)}`,
      );
    }
    if (plan.replicas !== null) {
      await this.kubernetes.scaleWorkload(
        kubeconfig,
        'Deployment',
        NAMESPACE,
        NAME,
        plan.replicas,
      );
      const copies =
        plan.replicas === 1 ? 'single copy' : String(plan.replicas) + ' copies';
      this.logger.log(
        `Put back the ${copies} of the API this installation chose`,
      );
    }
  }
}
