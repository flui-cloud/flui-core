import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { AppRevisionsRepository } from '../repositories/app-revisions.repository';
import { ApplicationEntity } from '../entities/application.entity';
import { ApplicationScaling } from '../interfaces/source-config.interface';
import { AppEventActorType, AppEventType } from '../enums/app-event-type.enum';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import { ApplicationResourceKind } from '../enums/application-resource-kind.enum';
import {
  AppAutoscalingDto,
  UpdateAutoscalingDto,
} from '../dto/app-management.dto';
import {
  ApplicationManifestGeneratorService,
  DEFAULT_TARGET_CPU,
} from './application-manifest-generator.service';

const HPA_KIND = ApplicationResourceKind.HORIZONTAL_POD_AUTOSCALER as string;

export interface AutoscalingRange {
  enabled: boolean;
  min: number;
  max: number;
  targetCPU: number;
}

export function rangeOf(
  scaling: ApplicationScaling | null | undefined,
): AutoscalingRange {
  const min = scaling?.horizontal?.min ?? scaling?.minReplicas ?? 1;
  const max =
    scaling?.horizontal?.max ?? scaling?.maxReplicas ?? Math.max(min, 1);
  return {
    enabled: Boolean(scaling?.enabled),
    min,
    max,
    targetCPU: scaling?.targetCPU ?? DEFAULT_TARGET_CPU,
  };
}

/**
 * The range an app built from a repository is given by its flui.yaml
 * (`deploy.scaling`); only the CPU target is the app's own to change.
 */
export function rangeFromManifest(app: {
  sourceType: ApplicationSourceType;
}): boolean {
  return app.sourceType === ApplicationSourceType.GIT_BUILD;
}

/** The stored `scaling` once a change is applied, refused where it cannot hold. */
export function nextScaling(
  app: Pick<ApplicationEntity, 'scaling' | 'sourceType' | 'workloadKind'>,
  dto: UpdateAutoscalingDto,
): ApplicationScaling {
  if (app.workloadKind === 'StatefulSet') {
    throw new BadRequestException(
      'This app keeps data on each replica, so its replica count does not follow the load: set it with `flui app scale --replicas`',
    );
  }
  const current = rangeOf(app.scaling);
  const min = dto.min ?? current.min;
  const max = dto.max ?? current.max;
  if (
    rangeFromManifest(app) &&
    (dto.enabled !== current.enabled ||
      min !== current.min ||
      max !== current.max)
  ) {
    throw new ConflictException(
      'This app is deployed from its flui.yaml, which holds its replica range: change `deploy.scaling` (min and max) there and deploy again. Only the CPU target can be changed here.',
    );
  }
  if (dto.enabled && max <= min) {
    throw new BadRequestException(
      `A range from ${min} to ${max} cannot grow: set max above min, or set a fixed count with \`flui app scale --replicas\``,
    );
  }
  const scaling: ApplicationScaling = {
    ...(app.scaling ?? { enabled: false }),
    enabled: dto.enabled,
    minReplicas: min,
    maxReplicas: max,
    targetCPU: dto.targetCPU ?? current.targetCPU,
  };
  if (scaling.horizontal) {
    scaling.horizontal = {
      ...scaling.horizontal,
      enabled: dto.enabled,
      min,
      max,
    };
  }
  return scaling;
}

@Injectable()
export class AppAutoscalingService {
  private readonly logger = new Logger(AppAutoscalingService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly applications: ApplicationsRepository,
    private readonly revisions: AppRevisionsRepository,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
    private readonly manifests: ApplicationManifestGeneratorService,
  ) {}

  async get(appId: string): Promise<AppAutoscalingDto> {
    const app = await this.appOrFail(appId);
    return this.view(app, await this.running(app));
  }

  async set(
    appId: string,
    dto: UpdateAutoscalingDto,
    actor?: { id?: string; name?: string },
  ): Promise<AppAutoscalingDto> {
    const app = await this.appOrFail(appId);
    const before = rangeOf(app.scaling);
    const scaling = nextScaling(app, dto);
    await this.applications.update(app.id, { scaling });
    const updated = { ...app, scaling } as ApplicationEntity;
    await this.reconcile(updated);

    await this.revisions.createAuditEvent({
      applicationId: app.id,
      eventType: AppEventType.SCALE,
      actor: actor
        ? { type: AppEventActorType.USER, ...actor }
        : { type: AppEventActorType.API },
      changeMetadata: {
        before: { autoscaling: before },
        after: { autoscaling: rangeOf(scaling) },
      },
    });

    return this.view(updated, await this.running(updated));
  }

  /**
   * Brings the cluster to the autoscaler the stored app asks for. Called on
   * every change of `scaling`, whichever route wrote it.
   */
  async reconcile(app: ApplicationEntity): Promise<void> {
    const kubeconfig = await this.kubeconfigOf(app);
    const wanted = this.manifests.autoscalerFor(app);
    if (wanted) {
      await this.kubernetes.applyManifest(kubeconfig, wanted.yaml);
      this.logger.log(
        `[${app.id}] replica autoscaler applied (${wanted.name})`,
      );
      return;
    }
    const name = `${app.slug}-hpa`;
    if (
      await this.kubernetes.getResource(
        kubeconfig,
        HPA_KIND,
        name,
        app.k8sNamespace,
      )
    ) {
      await this.kubernetes.deleteResource(
        kubeconfig,
        HPA_KIND,
        name,
        app.k8sNamespace,
      );
      this.logger.log(`[${app.id}] replica autoscaler removed (${name})`);
    }
  }

  private async running(app: ApplicationEntity): Promise<boolean | null> {
    try {
      const kubeconfig = await this.kubeconfigOf(app);
      return Boolean(
        await this.kubernetes.getResource(
          kubeconfig,
          HPA_KIND,
          `${app.slug}-hpa`,
          app.k8sNamespace,
        ),
      );
    } catch {
      return null;
    }
  }

  private view(
    app: ApplicationEntity,
    running: boolean | null,
  ): AppAutoscalingDto {
    return {
      ...rangeOf(app.scaling),
      rangeFrom: rangeFromManifest(app) ? 'manifest' : 'app',
      running,
    };
  }

  private async appOrFail(appId: string): Promise<ApplicationEntity> {
    const app = await this.applications.findById(appId);
    if (!app) throw new NotFoundException(`Application ${appId} not found`);
    return app;
  }

  private async kubeconfigOf(app: ApplicationEntity): Promise<string> {
    const cluster = await this.clusters.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new NotFoundException(
        `Cluster ${app.clusterId} has no kubeconfig available`,
      );
    }
    return this.encryption.decrypt(cluster.kubeconfigEncrypted);
  }
}
