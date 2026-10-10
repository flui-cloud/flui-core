import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationStatus } from '../../applications/enums/application-status.enum';
import { CatalogReusableInstanceDto } from '../dto/catalog-reusable-instance.dto';
import {
  CatalogDependency,
  CatalogSpecBuildingBlock,
} from '../interfaces/catalog-manifest.interface';
import {
  DependencyChoice,
  ResolvedDependency,
} from '../interfaces/resolved-dependency.interface';
import { DependencyMode } from '../enums/dependency-mode.enum';
import { CatalogInstallRepository } from '../repositories/catalog-install.repository';
import { CatalogAppDefinitionRepository } from '../repositories/catalog-app-definition.repository';
import { CatalogInstallStatus } from '../enums/catalog-install-status.enum';
import { CatalogInstallerService } from './catalog-installer.service';

export interface ResolveAllResult {
  resolved: ResolvedDependency[];
  dedicatedInstallIds: string[];
  /**
   * Map of alias → BB env keys that are secrets (generate / sensitive userInput).
   * Used by the processor to mark consumer envs referencing these keys as secret.
   */
  secretKeysByAlias: Record<string, Set<string>>;
  /**
   * Map of alias → K8s Secret name owning the BB's secret envs.
   */
  secretNameByAlias: Record<string, string>;
}

@Injectable()
export class CatalogDependencyResolverService {
  private readonly logger = new Logger(CatalogDependencyResolverService.name);

  constructor(
    private readonly applicationsRepo: ApplicationsRepository,
    private readonly installRepo: CatalogInstallRepository,
    private readonly definitionRepo: CatalogAppDefinitionRepository,
    private readonly installerService: CatalogInstallerService,
  ) {}

  async findReusableInstances(
    catalogSlug: string,
    clusterId: string,
    visible: (
      apps: ApplicationEntity[],
    ) => Promise<ApplicationEntity[]> = async (apps) => apps,
  ): Promise<CatalogReusableInstanceDto[]> {
    const apps = await visible(
      await this.applicationsRepo.findBuildingBlocksByCatalogSlug(
        clusterId,
        catalogSlug,
      ),
    );
    this.logger.log(
      `findReusableInstances(${catalogSlug}, ${clusterId}): ${apps.length} match(es)`,
    );
    return apps.map((app) => this.toDto(app, catalogSlug));
  }

  /**
   * Resolve every declared dependency of a catalog app at install time.
   *
   * For each entry in `deps`:
   *   - DEDICATED → installs the BB via installerService, polls until RUNNING,
   *     returns the fresh install id in `dedicatedInstallIds` for cascade uninstall.
   *   - REUSE_EXISTING → validates the referenced application is RUNNING on the
   *     same cluster and matches the required catalog slug.
   *
   * Returns a `ResolvedDependency[]` suitable for `TemplateContext.deps`, plus
   * side-channel maps (`secretKeysByAlias`, `secretNameByAlias`) the caller
   * uses to mark envs that reference secret BB envs with an externalSecretRef.
   */
  async resolveAll(
    deps: CatalogDependency[],
    choices: DependencyChoice[],
    clusterId: string,
    userId?: string,
    userEmail?: string,
    opts?: {
      waitTimeoutMs?: number;
      pollIntervalMs?: number;
      projectId?: string | null;
    },
  ): Promise<ResolveAllResult> {
    const result: ResolveAllResult = {
      resolved: [],
      dedicatedInstallIds: [],
      secretKeysByAlias: {},
      secretNameByAlias: {},
    };

    const waitTimeoutMs = opts?.waitTimeoutMs ?? 10 * 60 * 1000;
    const pollIntervalMs = opts?.pollIntervalMs ?? 3000;

    for (const dep of deps) {
      const choice = choices.find((c) => c.alias === dep.as);
      if (!choice) {
        if (dep.required !== false) {
          throw new BadRequestException(
            `Missing dependencyChoice for required dependency "${dep.as}" (ref=${dep.ref})`,
          );
        }
        continue;
      }

      let bbApp: ApplicationEntity;
      let bbSpec: CatalogSpecBuildingBlock;
      if (choice.mode === DependencyMode.REUSE_EXISTING) {
        ({ bbApp, bbSpec } = await this.resolveReuseExisting(
          dep,
          choice,
          clusterId,
        ));
      } else {
        const { install } = await this.installerService.installBuildingBlock(
          dep.ref,
          clusterId,
          userId,
          userEmail,
          opts?.projectId,
        );
        result.dedicatedInstallIds.push(install.id);
        const running = await this.waitForRunning(
          install.id,
          waitTimeoutMs,
          pollIntervalMs,
        );
        if (!running.applicationIds?.length) {
          throw new Error(
            `Dedicated dependency install ${install.id} (${dep.ref}) finished without an application`,
          );
        }
        const app = await this.applicationsRepo.findById(
          running.applicationIds[0],
        );
        if (!app) {
          throw new Error(
            `Application ${running.applicationIds[0]} not found for dep install ${install.id}`,
          );
        }
        const def = await this.definitionRepo.findById(
          running.catalogAppDefinitionId,
        );
        if (!def) {
          throw new Error(
            `Definition ${running.catalogAppDefinitionId} not found for dep install ${install.id}`,
          );
        }
        bbApp = app;
        bbSpec = def.manifest.spec as CatalogSpecBuildingBlock;
      }

      const host = `${bbApp.slug}-svc.${bbApp.k8sNamespace}.svc.cluster.local`;
      const port = bbSpec.ports[0]?.internal;
      const env: Record<string, string> = {};
      for (const e of bbApp.env ?? []) {
        env[e.name] = e.value ?? '';
      }

      const secretKeys = new Set<string>();
      for (const e of bbSpec.env) {
        const vf = e.valueFrom;
        if (!vf) continue;
        const isSecret =
          'generate' in vf ||
          ('userInput' in vf && !!vf.userInput.sensitive) ||
          'secretRef' in vf;
        if (isSecret) secretKeys.add(e.name);
      }

      const secretName = `${bbApp.slug}-secret`;

      result.resolved.push({
        alias: dep.as,
        ref: dep.ref,
        host,
        port,
        env,
        applicationId: bbApp.id,
        mode: choice.mode,
      });
      result.secretKeysByAlias[dep.as] = secretKeys;
      result.secretNameByAlias[dep.as] = secretName;

      this.logger.log(
        `Resolved dep alias=${dep.as} ref=${dep.ref} mode=${choice.mode} host=${host} port=${port} secretKeys=${Array.from(
          secretKeys,
        ).join(',')}`,
      );
    }

    return result;
  }

  private async resolveReuseExisting(
    dep: CatalogDependency,
    choice: DependencyChoice,
    clusterId: string,
  ): Promise<{ bbApp: ApplicationEntity; bbSpec: CatalogSpecBuildingBlock }> {
    if (!choice.existingApplicationId) {
      throw new BadRequestException(
        `dependencyChoice for alias "${dep.as}" has mode=REUSE_EXISTING but no existingApplicationId`,
      );
    }
    const bbApp = await this.applicationsRepo.findById(
      choice.existingApplicationId,
    );
    if (!bbApp) {
      throw new BadRequestException(
        `Existing application ${choice.existingApplicationId} not found`,
      );
    }
    if (bbApp.clusterId !== clusterId) {
      throw new BadRequestException(
        `Cross-cluster dependency not supported: consumer on ${clusterId}, dep app on ${bbApp.clusterId}`,
      );
    }
    if (
      bbApp.status !== ApplicationStatus.RUNNING &&
      bbApp.status !== ApplicationStatus.DEGRADED
    ) {
      throw new BadRequestException(
        `Existing application ${bbApp.slug} is not RUNNING (status=${bbApp.status})`,
      );
    }
    const catalogInstallId = bbApp.metadata?.catalogInstallId;
    if (!catalogInstallId) {
      throw new BadRequestException(
        `Application ${bbApp.slug} has no catalogInstallId — cannot reuse as dependency`,
      );
    }
    const bbInstall = await this.installRepo.findById(catalogInstallId);
    if (!bbInstall) {
      throw new BadRequestException(
        `Catalog install ${catalogInstallId} not found for app ${bbApp.slug}`,
      );
    }
    const bbDef = await this.definitionRepo.findById(
      bbInstall.catalogAppDefinitionId,
    );
    if (!bbDef) {
      throw new BadRequestException(
        `Catalog definition ${bbInstall.catalogAppDefinitionId} not found for reused dep`,
      );
    }
    if (bbDef.slug !== dep.ref) {
      throw new BadRequestException(
        `Reused application ${bbApp.slug} is ${bbDef.slug}, but dep requires ${dep.ref}`,
      );
    }
    return {
      bbApp,
      bbSpec: bbDef.manifest.spec as CatalogSpecBuildingBlock,
    };
  }

  private async waitForRunning(
    installId: string,
    timeoutMs: number,
    pollMs: number,
  ): Promise<
    import('../entities/catalog-install.entity').CatalogInstallEntity
  > {
    const deadline = Date.now() + timeoutMs;
    let last:
      | import('../entities/catalog-install.entity').CatalogInstallEntity
      | null = null;
    while (Date.now() < deadline) {
      const current = await this.installRepo.findById(installId);
      if (!current) {
        throw new Error(`Install ${installId} disappeared while polling`);
      }
      last = current;
      if (current.status === CatalogInstallStatus.RUNNING) return current;
      if (current.status === CatalogInstallStatus.FAILED) {
        throw new Error(
          `Dependency install ${installId} failed: ${current.errorMessage ?? 'unknown'}`,
        );
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(
      `Dependency install ${installId} did not reach RUNNING within ${timeoutMs}ms (last status=${last?.status})`,
    );
  }

  private toDto(
    app: ApplicationEntity,
    catalogSlug: string,
  ): CatalogReusableInstanceDto {
    const catalogInstallId = app.metadata?.catalogInstallId;
    return {
      applicationId: app.id,
      catalogInstallId,
      applicationName: app.name,
      catalogSlug,
      displayName: app.name,
      status: app.status,
      createdAt: app.createdAt,
    };
  }
}
