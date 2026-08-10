import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { CatalogInstallEntity } from '../../catalog/entities/catalog-install.entity';
import { ApplicationEntity } from '../entities/application.entity';
import { ApplicationExposure } from '../enums/application-exposure.enum';
import { ApplicationStatus } from '../enums/application-status.enum';
import {
  ApplicationGroupDto,
  ApplicationGroupType,
} from '../dto/application-group.dto';
import { ApplicationService } from './application.service';
import { ApplicationAccessService } from './application-access.service';
import {
  AppEndpointService,
  PrimaryEndpointState,
} from '../../dns/services/app-endpoint.service';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';

const CATALOG_INSTALL_LABEL = 'flui.cloud/catalog-install';

const STATUS_SEVERITY: ApplicationStatus[] = [
  ApplicationStatus.FAILED,
  ApplicationStatus.DEGRADED,
  ApplicationStatus.DELETING,
  ApplicationStatus.ROLLING_BACK,
  ApplicationStatus.UPDATING,
  ApplicationStatus.PROVISIONING,
  ApplicationStatus.AWAITING_BUILD,
  ApplicationStatus.PENDING,
  ApplicationStatus.STOPPED,
  ApplicationStatus.RUNNING,
  ApplicationStatus.DELETED,
];

@Injectable()
export class ApplicationGroupingService {
  constructor(
    private readonly applicationService: ApplicationService,
    @InjectRepository(CatalogInstallEntity)
    private readonly installRepo: Repository<CatalogInstallEntity>,
    private readonly access: ApplicationAccessService,
    @Inject(forwardRef(() => AppEndpointService))
    private readonly appEndpointService: AppEndpointService,
  ) {}

  async listGroupedByCluster(
    clusterId: string,
    user?: AuthenticatedUser,
  ): Promise<ApplicationGroupDto[]> {
    const all = await this.applicationService.findByClusterId(clusterId);
    // Resource-aware: a non-admin only sees groups whose components they may read.
    // Composed installs whose components are all filtered out simply don't appear.
    const apps = user ? await this.access.filterReadable(user, all) : all;
    const installs = await this.installRepo.find({
      where: { clusterId, deletedAt: IsNull() },
      relations: ['definition'],
    });
    const installById = new Map(installs.map((i) => [i.id, i]));

    const byInstall = new Map<string, ApplicationEntity[]>();
    const standalone: ApplicationEntity[] = [];
    for (const app of apps) {
      const installId = this.installIdOf(app);
      if (installId && installById.has(installId)) {
        const bucket = byInstall.get(installId) ?? [];
        bucket.push(app);
        byInstall.set(installId, bucket);
      } else {
        standalone.push(app);
      }
    }

    // One batched read for every component, so a group can tell an fqdn that
    // actually serves from one that was merely reserved (see applyPublicEndpoint).
    const endpoints = await this.appEndpointService.mapPrimaryEndpoints(
      apps.map((a) => a.id),
    );

    const groups: ApplicationGroupDto[] = [];
    for (const [installId, components] of byInstall) {
      groups.push(
        this.toComposedGroup(
          installById.get(installId)!,
          components,
          endpoints,
        ),
      );
    }
    for (const app of standalone) {
      groups.push(this.toStandaloneGroup(app));
    }

    return groups.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  private installIdOf(app: ApplicationEntity): string | undefined {
    return (
      app.metadata?.catalogInstallId ?? app.labels?.[CATALOG_INSTALL_LABEL]
    );
  }

  private toComposedGroup(
    install: CatalogInstallEntity,
    components: ApplicationEntity[],
    endpoints: Map<string, PrimaryEndpointState>,
  ): ApplicationGroupDto {
    const primary = this.pickPrimary(install, components);
    const dtos = components.map((c) => {
      const dto = this.applicationService.toResponseDto(c);
      dto.composedAppName = install.displayName;
      dto.isPrimary = c.id === primary?.id;
      const endpoint = endpoints.get(c.id);
      if (endpoint) {
        dto.endpointStatus = endpoint.reconciliationStatus;
        dto.endpointError = endpoint.errorMessage ?? undefined;
      }
      return dto;
    });
    // resolvedFqdn is stamped on the install as soon as the endpoint row exists,
    // well before anything serves that name — so the group's link follows the
    // primary component's endpoint, not the stored hostname.
    const primaryEndpoint = primary ? endpoints.get(primary.id) : undefined;
    const serving =
      primaryEndpoint?.reconciliationStatus === ReconciliationStatus.IN_SYNC;
    return {
      id: install.id,
      type: ApplicationGroupType.COMPOSED,
      name: install.displayName,
      slug: install.slug,
      status: this.aggregateStatus(components.map((c) => c.status)),
      category: (primary ?? components[0]).category,
      clusterId: install.clusterId,
      url:
        serving && install.resolvedFqdn
          ? `https://${install.resolvedFqdn}`
          : undefined,
      catalogSlug: install.definition?.slug,
      catalogInstallId: install.id,
      primaryComponentId: primary?.id,
      componentCount: components.length,
      components: dtos,
      createdAt: install.createdAt,
      updatedAt: components.reduce(
        (max, c) => (c.updatedAt > max ? c.updatedAt : max),
        install.updatedAt,
      ),
    };
  }

  private toStandaloneGroup(app: ApplicationEntity): ApplicationGroupDto {
    const dto = this.applicationService.toResponseDto(app);
    return {
      id: app.id,
      type: ApplicationGroupType.STANDALONE,
      name: app.name,
      slug: app.slug,
      status: app.status,
      category: app.category,
      clusterId: app.clusterId,
      catalogSlug: dto.catalogSlug,
      catalogInstallId: dto.catalogInstallId,
      componentCount: 1,
      components: [dto],
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
    };
  }

  private pickPrimary(
    install: CatalogInstallEntity,
    components: ApplicationEntity[],
  ): ApplicationEntity | undefined {
    if (install.resolvedFqdn) {
      const byFqdn = components.find((c) =>
        install.resolvedFqdn!.startsWith(`${c.slug}.`),
      );
      if (byFqdn) return byFqdn;
    }
    return (
      components.find((c) => c.exposure === ApplicationExposure.PUBLIC) ??
      components[0]
    );
  }

  private aggregateStatus(statuses: ApplicationStatus[]): ApplicationStatus {
    for (const candidate of STATUS_SEVERITY) {
      if (statuses.includes(candidate)) return candidate;
    }
    return ApplicationStatus.RUNNING;
  }
}
