import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { Repository } from 'typeorm';
import { randomBytes } from 'node:crypto';
import {
  InfrastructureOperationEntity,
  OperationType,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { OperationStepConfig } from '../../infrastructure/operations/helpers/operation-steps.helper';
import { CatalogAppDefinitionRepository } from '../repositories/catalog-app-definition.repository';
import { CatalogInstallRepository } from '../repositories/catalog-install.repository';
import { CatalogAppDefinitionEntity } from '../entities/catalog-app-definition.entity';
import { CatalogInstallEntity } from '../entities/catalog-install.entity';
import { CatalogInstallStatus } from '../enums/catalog-install-status.enum';
import { CatalogAppType } from '../enums/catalog-app-type.enum';
import { InstallCatalogAppDto } from '../dto/install-catalog-app.dto';
import { ResourceOverridesDto } from '../dto/resource-overrides.dto';
import { CatalogCapacityPreviewDto } from '../dto/catalog-capacity-preview.dto';
import { ResourceAvailabilityResponseDto } from '../../infrastructure/clusters/dto/resource-availability.dto';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationDeployService } from '../../applications/services/application-deploy.service';
import { CatalogLinkingService } from './catalog-linking.service';
import { CatalogService } from './catalog.service';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import {
  CatalogManifest,
  CatalogResources,
  CatalogScaling,
} from '../interfaces/catalog-manifest.interface';
import {
  parseCpuMillicores,
  parseMemoryMB,
} from '../../topology/services/topology-k8s.helper';

export const CATALOG_INSTALL_QUEUE = 'catalog-install';
export const CATALOG_INSTALL_JOB = 'install-catalog-app';
export const CATALOG_UNINSTALL_JOB = 'uninstall-catalog-app';

export interface CatalogInstallJobData {
  installId: string;
  operationId: string;
}

export interface CatalogUninstallJobData {
  installId: string;
  operationId: string;
}

@Injectable()
export class CatalogInstallerService {
  private readonly logger = new Logger(CatalogInstallerService.name);

  constructor(
    @InjectQueue(CATALOG_INSTALL_QUEUE)
    private readonly installQueue: Queue,
    private readonly definitionRepo: CatalogAppDefinitionRepository,
    private readonly installRepo: CatalogInstallRepository,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepo: Repository<InfrastructureOperationEntity>,
    private readonly applicationsRepo: ApplicationsRepository,
    private readonly deployService: ApplicationDeployService,
    private readonly linkingService: CatalogLinkingService,
    private readonly catalogService: CatalogService,
    private readonly clustersService: ClustersService,
  ) {}

  async install(
    slug: string,
    dto: InstallCatalogAppDto,
    userId?: string,
    userEmail?: string,
  ): Promise<{
    install: CatalogInstallEntity;
    operation: InfrastructureOperationEntity;
  }> {
    const definition = await this.definitionRepo.findPublishedBySlug(slug);
    if (!definition) {
      throw new BadRequestException(
        `Catalog app "${slug}" not found or not published`,
      );
    }

    this.validateUserInputs(definition, dto);
    this.validateDependencyChoices(definition, dto);
    // Preflight the same requirements↔cluster gate as the dashboard controller, so
    // every caller (HTTP, install-from-yaml, MCP/agent) fails fast with the structured
    // reason instead of enqueuing a job that dies at create-applications.
    await this.catalogService.assertCatalogAppInstallableOnCluster(
      slug,
      dto.clusterId,
    );
    // Capacity gate (parity with the dashboard deploy wizard): sum the resource
    // requests of every component this install will create and refuse if the cluster
    // cannot fit them within its 10% safety margin (unless autoscaling absorbs it).
    await this.assertClusterHasCapacity(definition, dto);

    const installSlug = `${definition.slug}-${this.randomSuffix()}`;

    const install = await this.installRepo.create({
      catalogAppDefinitionId: definition.id,
      clusterId: dto.clusterId,
      userId,
      userEmail,
      status: CatalogInstallStatus.PENDING,
      displayName: dto.displayName,
      slug: installSlug,
      requestedDomain: dto.domain,
      requestedCertChallenge: dto.certChallenge,
      requestedCertificateProvider: dto.certificateProvider,
      requestedHostnameMode: dto.hostnameMode,
      requestedTls: dto.tls,
      skipEndpoint: dto.skipEndpoint ?? false,
      allowMasterPlacement: dto.allowMasterPlacement ?? false,
      requestedExposure: dto.exposure,
      authMode: dto.authMode,
      options: dto.options ?? {},
      userInputs: dto.userInputs ?? {},
      envOverrides: dto.envOverrides ?? {},
      dependencyChoices: dto.dependencyChoices ?? [],
      resourceOverrides: dto.resourceOverrides,
      applicationIds: [],
    });

    const operationSteps = this.getInstallOperationSteps();
    const operation = this.operationRepo.create({
      operationType: OperationType.INSTALL_CATALOG_APP,
      status: OperationStatus.PENDING,
      resourceType: 'catalog-install',
      resourceName: install.displayName,
      resourceId: install.id,
      userId,
      totalSteps: operationSteps.length,
      currentStepIndex: 0,
      currentStepProgress: 0,
      metadata: {
        installId: install.id,
        installSlug: install.slug,
        catalogAppSlug: definition.slug,
        catalogAppVersion: definition.version,
        clusterId: dto.clusterId,
        operationSteps,
      },
    });
    const savedOperation = await this.operationRepo.save(operation);

    await this.installRepo.update(install.id, {
      operationId: savedOperation.id,
    });
    install.operationId = savedOperation.id;

    const jobData: CatalogInstallJobData = {
      installId: install.id,
      operationId: savedOperation.id,
    };
    await this.installQueue.add(CATALOG_INSTALL_JOB, jobData, {
      attempts: 1,
      timeout: 15 * 60 * 1000,
    });

    this.logger.log(
      `Queued catalog install: ${definition.slug}@${definition.version} → install ${install.id}`,
    );

    return { install, operation: savedOperation };
  }

  /**
   * Internal path to install a building block. Bypasses the public BUILDING_BLOCK
   * reject in {@link install}. Used by the dependency resolver (Iter 3) and by
   * integration tests. Not exposed on the public controller.
   */
  async installBuildingBlock(
    slug: string,
    clusterId: string,
    userId?: string,
    userEmail?: string,
  ): Promise<{
    install: CatalogInstallEntity;
    operation: InfrastructureOperationEntity;
  }> {
    const definition = await this.definitionRepo.findActiveBySlug(slug);
    if (!definition) {
      throw new BadRequestException(
        `Building block "${slug}" not found or inactive`,
      );
    }
    if (definition.appType !== CatalogAppType.BUILDING_BLOCK) {
      throw new BadRequestException(
        `Catalog app "${slug}" is not a building block (appType=${definition.appType})`,
      );
    }

    const installSlug = `${definition.slug}-${this.randomSuffix()}`;

    const install = await this.installRepo.create({
      catalogAppDefinitionId: definition.id,
      clusterId,
      userId,
      userEmail,
      status: CatalogInstallStatus.PENDING,
      displayName: definition.name,
      slug: installSlug,
      skipEndpoint: true,
      userInputs: {},
      envOverrides: {},
      dependencyChoices: [],
      applicationIds: [],
    });

    const operationSteps = this.getInstallOperationSteps();
    const operation = this.operationRepo.create({
      operationType: OperationType.INSTALL_CATALOG_APP,
      status: OperationStatus.PENDING,
      resourceType: 'catalog-install',
      resourceName: install.displayName,
      resourceId: install.id,
      userId,
      totalSteps: operationSteps.length,
      currentStepIndex: 0,
      currentStepProgress: 0,
      metadata: {
        installId: install.id,
        installSlug: install.slug,
        catalogAppSlug: definition.slug,
        catalogAppVersion: definition.version,
        clusterId,
        operationSteps,
        buildingBlock: true,
      },
    });
    const savedOperation = await this.operationRepo.save(operation);

    await this.installRepo.update(install.id, {
      operationId: savedOperation.id,
    });
    install.operationId = savedOperation.id;

    const jobData: CatalogInstallJobData = {
      installId: install.id,
      operationId: savedOperation.id,
    };
    await this.installQueue.add(CATALOG_INSTALL_JOB, jobData, {
      attempts: 1,
      timeout: 15 * 60 * 1000,
    });

    this.logger.log(
      `Queued building-block install: ${definition.slug}@${definition.version} → install ${install.id}`,
    );

    return { install, operation: savedOperation };
  }

  /**
   * Uninstall by the application id (what callers see in app listings) rather than
   * the internal install id: resolves the catalog install that owns the app on its
   * cluster, then delegates to {@link uninstall}.
   */
  /**
   * Resolve the catalog install that owns an application id on its cluster, or null
   * when the app was not created by a catalog install (a custom/source app). Lets
   * callers route removal to uninstall (whole install) vs delete (single app).
   */
  async findInstallByApplicationId(
    applicationId: string,
    clusterId: string,
  ): Promise<CatalogInstallEntity | null> {
    const installs = await this.installRepo.listByCluster(clusterId);
    return (
      installs.find((i) => i.applicationIds?.includes(applicationId)) ?? null
    );
  }

  /** Of the candidate hostnames, those that are a catalog install's resolved fqdn. */
  async existingResolvedFqdns(hosts: string[]): Promise<string[]> {
    return this.installRepo.existingResolvedFqdns(hosts);
  }

  /**
   * Refuse the install when the cluster cannot fit the sum of all its components'
   * CPU/memory requests (within the 10% safety margin). Same check the dashboard
   * deploy wizard runs before enabling the button — applied server-side so every
   * surface (HTTP, install-from-yaml, MCP/agent) honours it.
   */
  /**
   * The cluster footprint an install will request: the sum, across every
   * component the install will create, of CPU (requests — compressible, so gate
   * on the scheduling floor) and memory (limits, falling back to requests —
   * incompressible, so gate on the peak). Option-gated components are filtered
   * by `options`. resourceOverrides are folded in only for non-composed apps,
   * because composed components always deploy at manifest defaults
   * (buildComponentCreateDto ignores overrides) — counting a scaled-down
   * override here would let an install pass the gate then deploy bigger.
   *
   * Single source of truth shared by the install capacity gate and the
   * capacity-preview endpoint the dashboard renders, so they can never drift.
   */
  computeInstallFootprint(
    manifest: CatalogManifest,
    options: Record<string, boolean>,
    resourceOverrides?: ResourceOverridesDto,
  ): { cpu: number; memory: number } {
    const overrides =
      manifest.spec.type === CatalogAppType.COMPOSED
        ? undefined
        : resourceOverrides;

    let totalCpu = 0;
    let totalMemory = 0;
    for (const c of this.enumerateInstallComponents(manifest, options)) {
      const cpuRequest = overrides?.cpu?.request ?? c.resources?.requests?.cpu;
      const memoryLimit =
        overrides?.memory?.limit ?? c.resources?.limits?.memory;
      const memoryRequest =
        overrides?.memory?.request ?? c.resources?.requests?.memory;
      const memory = memoryLimit ?? memoryRequest;
      const replicas = overrides?.replicas ?? c.replicas;
      totalCpu += parseCpuMillicores(cpuRequest) * replicas;
      totalMemory += parseMemoryMB(memory) * replicas;
    }
    return { cpu: totalCpu, memory: totalMemory };
  }

  /**
   * Run the capacity gate without committing to an install. The dashboard deploy
   * wizard calls this with the same options + overrides it will install with and
   * renders required/available/canDeploy — so the preview shares
   * computeInstallFootprint with assertClusterHasCapacity and cannot drift.
   */
  async previewCapacity(
    definition: CatalogAppDefinitionEntity,
    dto: CatalogCapacityPreviewDto,
  ): Promise<ResourceAvailabilityResponseDto> {
    const { cpu, memory } = this.computeInstallFootprint(
      definition.manifest,
      dto.options ?? {},
      dto.resourceOverrides,
    );
    return this.clustersService.checkResourceAvailability(
      dto.clusterId,
      cpu,
      memory,
      1,
    );
  }

  private async assertClusterHasCapacity(
    definition: CatalogAppDefinitionEntity,
    dto: InstallCatalogAppDto,
  ): Promise<void> {
    // The user explicitly accepted the risk (peak memory may OOM-kill or
    // throttle the pods) — skip the gate entirely.
    if (dto.force) return;

    const { cpu: totalCpu, memory: totalMemory } = this.computeInstallFootprint(
      definition.manifest,
      dto.options ?? {},
      dto.resourceOverrides,
    );
    if (totalCpu === 0 && totalMemory === 0) return;

    const check = await this.clustersService.checkResourceAvailability(
      dto.clusterId,
      totalCpu,
      totalMemory,
      1,
    );
    if (!check.canDeploy) {
      throw new BadRequestException(
        `Not enough capacity on the cluster to install ${definition.name}: it needs about ${totalCpu}m CPU and up to ${totalMemory}Mi memory at peak, but only ${check.available.cpu} CPU and ${check.available.memory} memory are free (a 10% safety margin is kept). Free up resources (remove unused apps) or add capacity to the cluster, then try again.`,
      );
    }
  }

  /** Components an install will create, each with its declared resources + replicas. */
  private enumerateInstallComponents(
    manifest: CatalogManifest,
    options: Record<string, boolean>,
  ): Array<{ resources?: CatalogResources; replicas: number }> {
    const replicasOf = (scaling?: CatalogScaling): number =>
      scaling?.horizontal?.enabled ? (scaling.horizontal.min ?? 1) : 1;
    if (manifest.spec.type === CatalogAppType.COMPOSED) {
      const spec = manifest.spec;
      return spec.components
        .filter((c) => {
          const opt = c.when?.option;
          if (!opt) return true;
          const fallback =
            spec.options?.find((o) => o.key === opt)?.default ?? false;
          return options[opt] ?? fallback;
        })
        .map((c) => ({
          resources: c.resources,
          replicas: replicasOf(c.scaling),
        }));
    }
    const spec = manifest.spec;
    return [{ resources: spec.resources, replicas: replicasOf(spec.scaling) }];
  }

  async uninstallByApplicationId(
    applicationId: string,
    clusterId: string,
    userId?: string,
  ): Promise<{
    install: CatalogInstallEntity;
    operation: InfrastructureOperationEntity;
  }> {
    const match = await this.findInstallByApplicationId(
      applicationId,
      clusterId,
    );
    if (!match) {
      throw new BadRequestException(
        `Application ${applicationId} is not a catalog install — use the delete action instead.`,
      );
    }
    return this.uninstall(match.id, userId);
  }

  async uninstall(
    installId: string,
    userId?: string,
  ): Promise<{
    install: CatalogInstallEntity;
    operation: InfrastructureOperationEntity;
  }> {
    const install = await this.installRepo.findById(installId);
    if (!install) {
      throw new BadRequestException(`Install ${installId} not found`);
    }

    const operationSteps = this.getUninstallOperationSteps();
    const operation = this.operationRepo.create({
      operationType: OperationType.UNINSTALL_CATALOG_APP,
      status: OperationStatus.PENDING,
      resourceType: 'catalog-install',
      resourceName: install.displayName,
      resourceId: install.id,
      userId,
      totalSteps: operationSteps.length,
      currentStepIndex: 0,
      currentStepProgress: 0,
      metadata: {
        installId: install.id,
        operationSteps,
      },
    });
    const savedOperation = await this.operationRepo.save(operation);

    await this.installRepo.update(install.id, {
      status: CatalogInstallStatus.UNINSTALLING,
      operationId: savedOperation.id,
    });

    const jobData: CatalogUninstallJobData = {
      installId: install.id,
      operationId: savedOperation.id,
    };
    await this.installQueue.add(CATALOG_UNINSTALL_JOB, jobData, {
      attempts: 1,
      timeout: 10 * 60 * 1000,
    });

    return { install, operation: savedOperation };
  }

  /**
   * Connect (or switch) a client install to a running building block. Idempotent:
   *   - first call on a parked client (replicas=0) → resolves linked env,
   *     persists on the application, scales replicas to 1; K8s schedules the
   *     pod with the new env on the next reconcile
   *   - subsequent calls → rewrites the linked env entries and rolling-restarts
   *     the pod so it picks up the new secretKeyRef
   *
   * Credentials never flow through this API. Only the target install id is
   * passed in; secrets stay in the BB's K8s Secret and reach the client pod
   * via secretKeyRef.
   */
  async connect(
    installId: string,
    targetInstallId: string,
    userId?: string,
  ): Promise<CatalogInstallEntity> {
    const install = await this.installRepo.findById(installId);
    if (!install) {
      throw new NotFoundException(`Install ${installId} not found`);
    }
    if (userId && install.userId && install.userId !== userId) {
      throw new ForbiddenException(
        `Install ${installId} is owned by another user`,
      );
    }

    const definition = await this.definitionRepo.findById(
      install.catalogAppDefinitionId,
    );
    if (!definition) {
      throw new BadRequestException(
        `Catalog definition ${install.catalogAppDefinitionId} not found`,
      );
    }

    const manifest = definition.manifest;
    if (manifest.spec.type !== CatalogAppType.STANDALONE) {
      throw new BadRequestException(
        `Connect is only valid for standalone catalog apps (got ${manifest.spec.type})`,
      );
    }
    const spec = manifest.spec;
    if (!spec.linkedBuildingBlocks?.length) {
      throw new BadRequestException(
        `Catalog app "${definition.slug}" does not declare spec.linkedBuildingBlocks — connect is not applicable`,
      );
    }

    if (!install.applicationIds?.length) {
      throw new BadRequestException(
        `Install ${installId} has no application yet (still installing?)`,
      );
    }

    const linkedEnv = await this.linkingService.resolveLinkedEnv(
      install.clusterId,
      targetInstallId,
      spec.linkedBuildingBlocks,
    );

    const application = await this.applicationsRepo.findById(
      install.applicationIds[0],
    );
    if (!application) {
      throw new BadRequestException(
        `Application ${install.applicationIds[0]} not found`,
      );
    }

    const linkedNames = new Set(
      spec.linkedBuildingBlocks.flatMap((l) => l.envMapping.map((m) => m.name)),
    );
    const preserved = (application.env ?? []).filter(
      (e) => !linkedNames.has(e.name),
    );
    const nextEnv = [...preserved, ...linkedEnv];

    // Source of truth for "which BB am I connected to" is the application's
    // env (the externalSecretRef names the BB's Secret). No mirror on the
    // install row → no drift possible. GET /installs/:id resolves the
    // current target on read via CatalogService.resolveConnectedInstallId.
    await this.applicationsRepo.update(application.id, { env: nextEnv });

    // Full redeploy — not just a pod restart. A plain rolling restart via
    // annotation only recreates the pod from the EXISTING Deployment, which
    // still carries the old env. We need to regenerate ConfigMap/Secret/
    // Deployment manifests from the freshly updated ApplicationEntity.env
    // (which now holds the linked PGHOST/PGPORT/... and the externalSecretRef
    // for PGPASSWORD) and reapply them. triggerDeployWithImage does exactly
    // this and waits for readiness.
    const imageRef = application.imageRef ?? '';
    if (!imageRef) {
      throw new BadRequestException(
        `Application ${application.slug} has no imageRef; cannot redeploy`,
      );
    }
    try {
      await this.deployService.triggerDeployWithImage(
        application.id,
        imageRef,
        userId,
      );
    } catch (err) {
      this.logger.warn(
        `Redeploy of ${application.slug} after connect failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    this.logger.log(
      `Connected install ${install.slug} → target ${targetInstallId} (triggered redeploy of ${application.slug})`,
    );

    const refreshed = await this.installRepo.findById(install.id);
    return refreshed ?? install;
  }

  /**
   * Disconnect a client install from its linked building block. Removes the
   * env entries listed in spec.linkedBuildingBlock.envMapping from the
   * application and triggers a redeploy so the pod restarts without a
   * DATABASE_URL. The client's startCommand wrapper detects the missing
   * PGHOST and runs pgweb in its native "no connection" mode — pod stays
   * 1/1 Ready, no crash-loop.
   *
   * Idempotent: "connected" is derived from the application env (presence
   * of any externalSecretRef). If no linked env is there, disconnect is a
   * no-op.
   */
  async disconnect(
    installId: string,
    userId?: string,
  ): Promise<CatalogInstallEntity> {
    const install = await this.installRepo.findById(installId);
    if (!install) {
      throw new NotFoundException(`Install ${installId} not found`);
    }
    if (userId && install.userId && install.userId !== userId) {
      throw new ForbiddenException(
        `Install ${installId} is owned by another user`,
      );
    }

    const definition = await this.definitionRepo.findById(
      install.catalogAppDefinitionId,
    );
    if (!definition) {
      throw new BadRequestException(
        `Catalog definition ${install.catalogAppDefinitionId} not found`,
      );
    }
    const manifest = definition.manifest;
    if (manifest.spec.type !== CatalogAppType.STANDALONE) {
      throw new BadRequestException(
        `Disconnect is only valid for standalone catalog apps (got ${manifest.spec.type})`,
      );
    }
    const spec = manifest.spec;
    if (!spec.linkedBuildingBlocks?.length) {
      throw new BadRequestException(
        `Catalog app "${definition.slug}" does not declare spec.linkedBuildingBlocks — disconnect is not applicable`,
      );
    }

    if (!install.applicationIds?.length) {
      throw new BadRequestException(`Install ${installId} has no application`);
    }
    const application = await this.applicationsRepo.findById(
      install.applicationIds[0],
    );
    if (!application) {
      throw new BadRequestException(
        `Application ${install.applicationIds[0]} not found`,
      );
    }

    const linkedNames = new Set(
      spec.linkedBuildingBlocks.flatMap((l) => l.envMapping.map((m) => m.name)),
    );
    const currentEnv = application.env ?? [];
    const hadLinkedEnv = currentEnv.some((e) => linkedNames.has(e.name));
    if (!hadLinkedEnv) {
      // Already disconnected (or never connected) — nothing to do.
      return install;
    }
    const nextEnv = currentEnv.filter((e) => !linkedNames.has(e.name));

    await this.applicationsRepo.update(application.id, { env: nextEnv });

    const imageRef = application.imageRef ?? '';
    if (!imageRef) {
      throw new BadRequestException(
        `Application ${application.slug} has no imageRef; cannot redeploy`,
      );
    }
    try {
      await this.deployService.triggerDeployWithImage(
        application.id,
        imageRef,
        userId,
      );
    } catch (err) {
      this.logger.warn(
        `Redeploy of ${application.slug} after disconnect failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    this.logger.log(
      `Disconnected install ${install.slug} (triggered redeploy of ${application.slug})`,
    );

    return install;
  }

  private validateUserInputs(
    definition: CatalogAppDefinitionEntity,
    dto: InstallCatalogAppDto,
  ): void {
    const spec = definition.manifest.spec;
    if (spec.type !== CatalogAppType.STANDALONE) return;

    const errors: string[] = [];
    for (const envVar of spec.env) {
      const valueFrom = envVar.valueFrom;
      if (!valueFrom || !('userInput' in valueFrom)) continue;
      const prompt = valueFrom.userInput;
      const provided = dto.userInputs?.[envVar.name];
      const effective = provided ?? prompt.default;

      if (effective === undefined || effective === '') {
        errors.push(`${envVar.name}: required`);
        continue;
      }

      if (
        prompt.minLength !== undefined &&
        effective.length < prompt.minLength
      ) {
        errors.push(
          `${envVar.name}: must be at least ${prompt.minLength} characters`,
        );
      }
      if (
        prompt.maxLength !== undefined &&
        effective.length > prompt.maxLength
      ) {
        errors.push(
          `${envVar.name}: must be at most ${prompt.maxLength} characters`,
        );
      }
      if (prompt.pattern) {
        let re: RegExp;
        try {
          re = new RegExp(prompt.pattern);
        } catch {
          this.logger.warn(
            `Invalid regex in manifest for ${definition.slug}/${envVar.name}: "${prompt.pattern}" — skipping pattern check`,
          );
          continue;
        }
        if (!re.test(effective)) {
          const description =
            prompt.patternDescription ?? `does not match ${prompt.pattern}`;
          errors.push(`${envVar.name}: ${description}`);
        }
      }
    }

    if (errors.length) {
      throw new BadRequestException({
        message: 'User input validation failed',
        errors,
      });
    }
  }

  private validateDependencyChoices(
    definition: CatalogAppDefinitionEntity,
    dto: InstallCatalogAppDto,
  ): void {
    const spec = definition.manifest.spec;
    if (
      spec.type !== CatalogAppType.STANDALONE &&
      spec.type !== CatalogAppType.BUILDING_BLOCK
    )
      return;
    const deps = spec.dependencies ?? [];
    if (!deps.length) return;

    const choices = dto.dependencyChoices ?? [];
    const errors: string[] = [];
    const aliases = new Set<string>();
    for (const dep of deps) {
      aliases.add(dep.as);
      const choice = choices.find((c) => c.alias === dep.as);
      if (!choice) {
        if (dep.required !== false) {
          errors.push(
            `dependency "${dep.as}" (ref=${dep.ref}) requires a dependencyChoice`,
          );
        }
        continue;
      }
      if (choice.mode === 'REUSE_EXISTING' && !choice.existingApplicationId) {
        errors.push(
          `dependencyChoice for "${dep.as}" has mode=REUSE_EXISTING but no existingApplicationId`,
        );
      }
    }
    for (const choice of choices) {
      if (!aliases.has(choice.alias)) {
        errors.push(
          `dependencyChoice alias "${choice.alias}" does not match any spec.dependencies[].as`,
        );
      }
    }
    if (errors.length) {
      throw new BadRequestException({
        message: 'Dependency choice validation failed',
        errors,
      });
    }
  }

  private randomSuffix(): string {
    return randomBytes(3).toString('hex');
  }

  private getInstallOperationSteps(): OperationStepConfig[] {
    return [
      {
        step: OperationStep.CATALOG_INSTALL_INIT,
        description: 'Initializing install',
        weight: 5,
      },
      {
        step: OperationStep.CATALOG_INSTALL_RESOLVE_DEPS,
        description: 'Resolving dependencies',
        weight: 5,
      },
      {
        step: OperationStep.CATALOG_INSTALL_GENERATE_SECRETS,
        description: 'Generating secrets',
        weight: 5,
      },
      {
        step: OperationStep.CATALOG_INSTALL_RESOLVE_TEMPLATES,
        description: 'Resolving templates',
        weight: 10,
      },
      {
        step: OperationStep.CATALOG_INSTALL_CREATE_APPLICATIONS,
        description: 'Creating applications',
        weight: 10,
      },
      {
        step: OperationStep.CATALOG_INSTALL_DEPLOY_COMPONENTS,
        description: 'Deploying components',
        weight: 55,
      },
      {
        step: OperationStep.CATALOG_INSTALL_CREATE_ENDPOINTS,
        description: 'Provisioning endpoints',
        weight: 5,
      },
      {
        step: OperationStep.CATALOG_INSTALL_FINALIZE,
        description: 'Finalizing',
        weight: 5,
      },
    ];
  }

  private getUninstallOperationSteps(): OperationStepConfig[] {
    return [
      {
        step: OperationStep.CATALOG_UNINSTALL_INIT,
        description: 'Initializing uninstall',
        weight: 10,
      },
      {
        step: OperationStep.CATALOG_UNINSTALL_DELETE_APPS,
        description: 'Removing applications',
        weight: 80,
      },
      {
        step: OperationStep.CATALOG_UNINSTALL_FINALIZE,
        description: 'Finalizing',
        weight: 10,
      },
    ];
  }
}
