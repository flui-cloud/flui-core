import { Processor, Process } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { ApplicationService } from '../../applications/services/application.service';
import { ApplicationDeployService } from '../../applications/services/application-deploy.service';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { DeployConfigService } from '../../applications/services/deploy-config.service';
import { ApplicationStatus } from '../../applications/enums/application-status.enum';
import { ApplicationSourceType } from '../../applications/enums/application-source-type.enum';
import { ApplicationCategory } from '../../applications/enums/application-category.enum';

import { mapCatalogCategoryToKind } from '../utils/category-to-kind';
import { ApplicationExposure } from '../../applications/enums/application-exposure.enum';
import { CreateApplicationDto } from '../../applications/dto/create-application.dto';
import {
  ApplicationScaling,
  ApplicationHealthProbe,
} from '../../applications/interfaces/source-config.interface';
import { AppEndpointService } from '../../dns/services/app-endpoint.service';
import { AppEndpointReconciliationService } from '../../dns/services/app-endpoint-reconciliation.service';
import { ClusterDnsZoneService } from '../../dns/services/cluster-dns-zone.service';
import { CertChallenge } from '../../dns/enums/cert-challenge.enum';
import { HostnameMode } from '../../dns/enums/hostname-mode.enum';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';
import {
  CatalogDomainSpec,
  CatalogSpecStandalone,
  CatalogSpecBuildingBlock,
  CatalogSpecComposed,
  CatalogComponent,
  CatalogPostInstallStep,
  CatalogEnvVar,
  CatalogHealthcheck,
  CatalogImageSource,
  CatalogResources,
  CatalogScaling,
  CatalogVolume,
} from '../interfaces/catalog-manifest.interface';
import { CatalogAppDefinitionRepository } from '../repositories/catalog-app-definition.repository';
import { CatalogInstallRepository } from '../repositories/catalog-install.repository';
import { CatalogInstallEntity } from '../entities/catalog-install.entity';
import { CatalogAppDefinitionEntity } from '../entities/catalog-app-definition.entity';
import { CatalogInstallStatus } from '../enums/catalog-install-status.enum';
import { CatalogAppType } from '../enums/catalog-app-type.enum';
import {
  TemplateContext,
  TemplateComponentContext,
} from '../interfaces/template-context.interface';
import { CatalogTemplateResolverService } from '../services/catalog-template-resolver.service';
import { CatalogSecretGeneratorService } from '../services/catalog-secret-generator.service';
import { CatalogDependencyResolverService } from '../services/catalog-dependency-resolver.service';
import {
  CATALOG_INSTALL_QUEUE,
  CATALOG_INSTALL_JOB,
  CATALOG_UNINSTALL_JOB,
  CatalogInstallerService,
  CatalogInstallJobData,
  CatalogUninstallJobData,
} from '../services/catalog-installer.service';
import { buildUserNamespace } from '../../applications/utils/k8s-namespace.util';
import { OidcProviderAdminClient } from '../../oidc/services/oidc-provider-admin.service';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { buildSystemNipHostname } from '../../dns/utils/nip-hostname.util';
import { randomUUID } from 'node:crypto';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { EndpointModeResolverService } from '../../dns/services/endpoint-mode-resolver.service';

interface ResolvedEnv {
  name: string;
  value: string;
  secret: boolean;
  externalSecretRef?: { secretName: string; key: string };
}

interface OidcWireResult {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
}

@Processor(CATALOG_INSTALL_QUEUE)
export class CatalogInstallProcessor {
  private readonly logger = new Logger(CatalogInstallProcessor.name);

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepo: Repository<InfrastructureOperationEntity>,
    private readonly definitionRepo: CatalogAppDefinitionRepository,
    private readonly installRepo: CatalogInstallRepository,
    private readonly applicationService: ApplicationService,
    private readonly applicationRepo: ApplicationsRepository,
    private readonly deployService: ApplicationDeployService,
    private readonly appEndpointService: AppEndpointService,
    private readonly appEndpointReconciliationService: AppEndpointReconciliationService,
    private readonly clusterDnsZoneService: ClusterDnsZoneService,
    private readonly templateResolver: CatalogTemplateResolverService,
    private readonly secretGenerator: CatalogSecretGeneratorService,
    private readonly deployConfig: DeployConfigService,
    private readonly dependencyResolver: CatalogDependencyResolverService,
    private readonly installerService: CatalogInstallerService,
    private readonly oidcProvider: OidcProviderAdminClient,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly endpointModeResolver: EndpointModeResolverService,
  ) {}

  @Process({ name: CATALOG_INSTALL_JOB, concurrency: 5 })
  async handleInstall(job: Job<CatalogInstallJobData>): Promise<void> {
    const { installId, operationId } = job.data;
    this.logger.log(`Processing catalog install ${installId}`);

    try {
      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        0,
        OperationStep.CATALOG_INSTALL_INIT,
      );
      await this.installRepo.updateStatus(
        installId,
        CatalogInstallStatus.INSTALLING,
      );

      const install = await this.installRepo.findById(installId);
      if (!install) {
        throw new Error(`Install ${installId} not found`);
      }
      const definition = await this.definitionRepo.findById(
        install.catalogAppDefinitionId,
      );
      if (!definition) {
        throw new Error(
          `Catalog definition ${install.catalogAppDefinitionId} not found`,
        );
      }

      const manifest = definition.manifest;
      if (manifest.spec.type === CatalogAppType.COMPOSED) {
        await this.handleComposedInstall(
          install,
          definition,
          manifest.spec,
          operationId,
        );
        return;
      }
      const spec = manifest.spec;

      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        10,
        OperationStep.CATALOG_INSTALL_RESOLVE_DEPS,
      );

      const deps =
        spec.type === CatalogAppType.STANDALONE ||
        spec.type === CatalogAppType.BUILDING_BLOCK
          ? (spec.dependencies ?? [])
          : [];
      this.logger.log(
        `[deps-debug] install=${install.id} type=${spec.type} deps=${JSON.stringify(deps)} choices=${JSON.stringify(install.dependencyChoices)}`,
      );
      const depResolution = deps.length
        ? await this.dependencyResolver.resolveAll(
            deps,
            install.dependencyChoices ?? [],
            install.clusterId,
            install.userId,
            install.userEmail,
          )
        : {
            resolved: [],
            dedicatedInstallIds: [],
            secretKeysByAlias: {},
            secretNameByAlias: {},
          };
      this.logger.log(
        `[deps-debug] install=${install.id} resolved=${JSON.stringify(depResolution.resolved.map((r) => ({ alias: r.alias, host: r.host, port: r.port, envKeys: Object.keys(r.env) })))}`,
      );

      if (depResolution.dedicatedInstallIds.length) {
        await this.installRepo.update(install.id, {
          dependencyInstallIds: depResolution.dedicatedInstallIds,
        });
      }

      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        20,
        OperationStep.CATALOG_INSTALL_GENERATE_SECRETS,
      );

      const resolvedEnv = this.resolveEnv(spec.env, install);

      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        30,
        OperationStep.CATALOG_INSTALL_RESOLVE_TEMPLATES,
      );

      const ctx = this.buildTemplateContext(install, resolvedEnv);
      ctx.deps = Object.fromEntries(
        depResolution.resolved.map((d) => [
          d.alias,
          { host: d.host, port: d.port, env: d.env },
        ]),
      );
      const finalEnv = this.substituteEnvValuesWithDeps(
        spec.env,
        resolvedEnv,
        ctx,
        depResolution.secretKeysByAlias,
        depResolution.secretNameByAlias,
      );

      // NB: linking for clients (manifest with spec.linkedBuildingBlocks) is
      // never resolved at install-time anymore. Clients start parked
      // (replicas=0) and pick up env on the first POST /installs/:id/connect.
      ctx.env = Object.fromEntries(finalEnv.map((e) => [e.name, e.value]));

      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        40,
        OperationStep.CATALOG_INSTALL_CREATE_APPLICATIONS,
      );

      const dto = this.buildCreateApplicationDto(
        definition,
        install,
        spec,
        finalEnv,
        ctx,
      );
      const application = await this.applicationService.create(
        install.clusterId,
        dto,
        install.userId,
        install.userEmail,
      );

      await this.installRepo.update(install.id, {
        applicationIds: [application.id],
      });

      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        50,
        OperationStep.CATALOG_INSTALL_DEPLOY_COMPONENTS,
      );

      const imageRef = this.buildImageRef(spec.image);
      const deployOp = await this.deployService.triggerDeployWithImage(
        application.id,
        imageRef,
        install.userId,
      );

      const deployResult = await this.waitForDeployOperation(
        deployOp.id,
        application.id,
        this.deployConfig.getCatalogInstallWaitTimeoutMs(),
        this.deployConfig.getCatalogInstallPollIntervalMs(),
      );
      if (!deployResult.ok) {
        throw new Error(
          `Deploy failed for application ${application.id}: ${deployResult.error ?? 'unknown'}`,
        );
      }

      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        85,
        OperationStep.CATALOG_INSTALL_CREATE_ENDPOINTS,
      );

      if (spec.type === CatalogAppType.STANDALONE) {
        if (dto.exposure === ApplicationExposure.INTERNAL) {
          this.logger.log(
            `Install ${install.id}: exposure=internal — skipping public endpoint (no Ingress/DNS/Certificate); app reachable via ForwardAuth proxy`,
          );
        } else {
          await this.maybeCreateEndpoint(install, application.id, spec);
        }
      }

      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        95,
        OperationStep.CATALOG_INSTALL_FINALIZE,
      );

      await this.installRepo.updateStatus(
        install.id,
        CatalogInstallStatus.RUNNING,
      );
      await this.updateOperation(
        operationId,
        OperationStatus.COMPLETED,
        100,
        OperationStep.CATALOG_INSTALL_FINALIZE,
      );

      this.logger.log(`Catalog install ${install.id} completed`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Catalog install ${installId} failed: ${message}`);
      await this.installRepo.updateStatus(
        installId,
        CatalogInstallStatus.FAILED,
        message,
      );
      await this.updateOperation(
        operationId,
        OperationStatus.FAILED,
        undefined,
        undefined,
        message,
      );
      throw err;
    }
  }

  @Process(CATALOG_UNINSTALL_JOB)
  async handleUninstall(job: Job<CatalogUninstallJobData>): Promise<void> {
    const { installId, operationId } = job.data;
    this.logger.log(`Processing catalog uninstall ${installId}`);

    try {
      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        0,
        OperationStep.CATALOG_UNINSTALL_INIT,
      );

      const install = await this.installRepo.findById(installId);
      if (!install) {
        throw new Error(`Install ${installId} not found`);
      }

      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        20,
        OperationStep.CATALOG_UNINSTALL_DELETE_APPS,
      );

      const labelled = await this.applicationRepo.findByCatalogInstall(
        install.id,
      );
      const appIds = [
        ...new Set([...install.applicationIds, ...labelled.map((a) => a.id)]),
      ];
      for (const appId of appIds) {
        try {
          await this.deployService.deleteApplication(appId, install.userId);
        } catch (err) {
          this.logger.warn(
            `Failed to delete application ${appId} during uninstall ${install.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      await this.cleanupOidcClient(install);

      for (const depInstallId of install.dependencyInstallIds ?? []) {
        try {
          await this.installerService.uninstall(depInstallId, install.userId);
          this.logger.log(
            `Cascade-uninstalled dedicated dep ${depInstallId} for install ${install.id}`,
          );
        } catch (err) {
          this.logger.warn(
            `Failed to cascade-uninstall dep ${depInstallId} of install ${install.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      await this.installRepo.update(install.id, {
        status: CatalogInstallStatus.UNINSTALLED,
        deletedAt: new Date(),
      });

      await this.updateOperation(
        operationId,
        OperationStatus.COMPLETED,
        100,
        OperationStep.CATALOG_UNINSTALL_FINALIZE,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Catalog uninstall ${installId} failed: ${message}`);
      await this.updateOperation(
        operationId,
        OperationStatus.FAILED,
        undefined,
        undefined,
        message,
      );
      throw err;
    }
  }

  private async resolveOidcProviderDomain(
    install: CatalogInstallEntity,
  ): Promise<{ pat: string; providerDomain: string } | null> {
    const pat = process.env.ZITADEL_SERVICE_ACCOUNT_PAT;
    if (!pat) return null;
    const cluster = await this.clusterRepository.findOne({
      where: { id: install.clusterId },
    });
    if (!cluster?.masterIpAddress) return null;
    const providerDomain = buildSystemNipHostname(
      'auth',
      cluster.masterIpAddress,
      cluster.nipHostnameToken,
    );
    return { pat, providerDomain };
  }

  private async cleanupOidcClient(
    install: CatalogInstallEntity,
  ): Promise<void> {
    if (!install.oidcAppId || !install.oidcProjectId) return;
    try {
      const domain = await this.resolveOidcProviderDomain(install);
      if (!domain) return;
      await this.oidcProvider.deleteOidcApp(
        domain.pat,
        domain.providerDomain,
        install.oidcProjectId,
        install.oidcAppId,
      );
      this.logger.log(
        `Install ${install.id}: removed OIDC client ${install.oidcAppId}`,
      );
    } catch (err) {
      this.logger.warn(
        `Install ${install.id}: failed to remove OIDC client ${install.oidcAppId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private resolveEnv(
    envSpec: CatalogEnvVar[],
    install: CatalogInstallEntity,
  ): ResolvedEnv[] {
    const out: ResolvedEnv[] = [];
    for (const e of envSpec) {
      const override = install.envOverrides?.[e.name];

      if (e.valueFrom && 'generate' in e.valueFrom) {
        out.push({
          name: e.name,
          value: this.secretGenerator.generate(
            e.valueFrom.length,
            e.valueFrom.format ?? 'base64url',
          ),
          secret: true,
        });
        continue;
      }
      if (e.valueFrom && 'userInput' in e.valueFrom) {
        const provided =
          install.userInputs?.[e.name] ?? e.valueFrom.userInput.default ?? '';
        out.push({
          name: e.name,
          value: provided,
          secret: !!e.valueFrom.userInput.sensitive,
        });
        continue;
      }
      if (e.valueFrom && 'secretRef' in e.valueFrom) {
        throw new Error(
          `valueFrom.secretRef is not supported in Iteration 1 (var ${e.name})`,
        );
      }

      const rawValue = override ?? e.value ?? '';
      out.push({ name: e.name, value: rawValue, secret: !!e.secret });
    }
    return out;
  }

  private buildTemplateContext(
    install: CatalogInstallEntity,
    env: ResolvedEnv[],
  ): TemplateContext {
    const namespace = install.userEmail
      ? buildUserNamespace(install.userEmail)
      : 'default';
    return {
      app: {
        id: install.slug,
        slug: install.slug,
        domain: install.requestedDomain,
        namespace,
      },
      env: Object.fromEntries(env.map((e) => [e.name, e.value])),
    };
  }

  private substituteEnvValuesWithDeps(
    envSpec: CatalogEnvVar[],
    env: ResolvedEnv[],
    ctx: TemplateContext,
    secretKeysByAlias: Record<string, Set<string>>,
    secretNameByAlias: Record<string, string>,
  ): ResolvedEnv[] {
    const EXACT_DEP_SECRET = /^\{\{\s*deps\.([^.]+)\.env\.([^.}\s]+)\s*\}\}$/;
    const ANY_DEP_SECRET = /\{\{\s*deps\.([^.]+)\.env\.([^.}\s]+)\s*\}\}/g;

    return env.map((e, idx) => {
      const rawValue = envSpec[idx]?.value ?? e.value;
      const raw = rawValue ?? '';

      const exactMatch = EXACT_DEP_SECRET.exec(raw);
      if (exactMatch) {
        const [, alias, key] = exactMatch;
        const secretKeys = secretKeysByAlias[alias];
        const secretName = secretNameByAlias[alias];
        if (secretKeys?.has(key) && secretName) {
          return {
            name: e.name,
            value: '',
            secret: true,
            externalSecretRef: { secretName, key },
          };
        }
      }

      let referencesSecret = false;
      const matches = raw.matchAll(ANY_DEP_SECRET);
      for (const m of matches) {
        const alias = m[1];
        const key = m[2];
        if (secretKeysByAlias[alias]?.has(key)) {
          referencesSecret = true;
          break;
        }
      }

      return {
        name: e.name,
        value: this.templateResolver.resolve(e.value, ctx),
        secret: e.secret || referencesSecret,
      };
    });
  }

  private buildCreateApplicationDto(
    definition: CatalogAppDefinitionEntity,
    install: CatalogInstallEntity,
    spec: CatalogSpecStandalone | CatalogSpecBuildingBlock,
    env: ResolvedEnv[],
    ctx: TemplateContext,
  ): CreateApplicationDto {
    const primaryPort = spec.ports[0];
    const imageRef = this.buildImageRef(spec.image);
    const isBuildingBlock =
      definition.appType === CatalogAppType.BUILDING_BLOCK;
    const manifestExposure: 'public' | 'internal' =
      spec.type === CatalogAppType.STANDALONE
        ? (spec.exposure ?? 'public')
        : 'public';
    const privatizable =
      !isBuildingBlock &&
      manifestExposure !== 'internal' &&
      (spec.type === CatalogAppType.STANDALONE
        ? spec.privatizable !== false
        : false);
    const effectiveExposure: 'public' | 'internal' =
      privatizable && install.requestedExposure === 'internal'
        ? 'internal'
        : manifestExposure;
    const exposure: ApplicationExposure = isBuildingBlock
      ? ApplicationExposure.CLUSTER
      : effectiveExposure === 'internal'
        ? ApplicationExposure.INTERNAL
        : ApplicationExposure.PUBLIC;

    this.logger.log(
      `[exposure-debug] install=${install.id} slug=${install.slug} ` +
        `requestedExposure=${install.requestedExposure} ` +
        `spec.type=${spec.type} spec.exposure=${(spec as any).exposure} spec.privatizable=${(spec as any).privatizable} ` +
        `isBuildingBlock=${isBuildingBlock} manifestExposure=${manifestExposure} ` +
        `privatizable=${privatizable} effectiveExposure=${effectiveExposure} ` +
        `→ exposure=${exposure}`,
    );

    return {
      name: install.slug,
      description: definition.description,
      category: ApplicationCategory.USER,
      kind: definition.appKind ?? mapCatalogCategoryToKind(definition.category),
      sourceType: ApplicationSourceType.DOCKER_IMAGE,
      k8sNamespace: ctx.app.namespace,
      sourceConfig: {
        type: 'docker_image',
        imageRef,
        pullPolicy: 'IfNotPresent',
      },
      env: env.map((e) => ({
        name: e.name,
        value: e.value,
        secret: e.secret,
        externalSecretRef: e.externalSecretRef,
      })),
      resources: this.applyResourceOverrides(
        this.mapResources(spec.resources),
        install.resourceOverrides,
      ),
      scaling: this.mapScaling(spec.scaling),
      replicas: this.resolveReplicas(spec, install.resourceOverrides),
      port: primaryPort?.internal,
      portProtocol: primaryPort?.protocol,
      allowMasterPlacement:
        install.allowMasterPlacement ||
        process.env.FLUI_ALLOW_MASTER === 'true',
      healthProbe: this.mapHealthProbe(
        this.resolveHealthcheckTemplates(spec.healthcheck, ctx),
        primaryPort?.internal,
      ),
      volumes: this.mapVolumes(spec.volumes),
      workloadKind: isBuildingBlock ? 'StatefulSet' : 'Deployment',
      persistenceScope: spec.persistence?.scope ?? 'shared',
      startCommand: spec.startCommand,
      command: spec.command,
      securityContext: spec.securityContext,
      configFiles: spec.configFiles,
      labels: {
        'flui.cloud/catalog-app': definition.slug,
        'flui.cloud/catalog-install': install.id,
        'flui.cloud/app-type': definition.appType,
        // Only a building block can be a datastore; standalone apps never are.
        ...(spec.type === CatalogAppType.BUILDING_BLOCK &&
          spec.engine && { 'flui.cloud/db-engine': spec.engine }),
      },
      metadata: {
        catalogInstallId: install.id,
        catalogDefinitionId: definition.id,
        catalogVersion: definition.version,
      },
      exposure,
    };
  }

  private async maybeCreateEndpoint(
    install: CatalogInstallEntity,
    applicationId: string,
    spec: CatalogSpecStandalone,
  ): Promise<void> {
    const exposedPort = spec.ports.find((p) => p.expose);
    if (!exposedPort || spec.domain?.auto === false) {
      this.logger.log(
        `Install ${install.id}: no exposed port or domain.auto=false — skipping endpoint`,
      );
      return;
    }

    if (install.skipEndpoint) {
      this.logger.log(
        `Install ${install.id}: skipEndpoint=true — user will configure domain/TLS later`,
      );
      return;
    }

    const assignment = install.requestedDomain
      ? await this.clusterDnsZoneService.getZoneForFqdn(
          install.clusterId,
          install.requestedDomain,
        )
      : await this.clusterDnsZoneService.getZoneAssignment(install.clusterId);
    const wildcardIssuer = assignment?.dnsZone?.zoneName
      ? await this.clusterDnsZoneService.resolveWildcardIssuer(
          install.clusterId,
        )
      : null;

    const domainHints = this.mapDomainSpecToEndpointDto(
      spec.domain,
      wildcardIssuer?.certificateProvider,
    );

    // Install params win over the manifest; http-01 forces a per-host cert even on a wildcard zone.
    if (install.requestedCertChallenge === 'http-01')
      domainHints.certChallenge = CertChallenge.HTTP_01;
    else if (install.requestedCertChallenge === 'dns-01')
      domainHints.certChallenge = CertChallenge.DNS_01;

    if (install.requestedHostnameMode === 'ip')
      domainHints.hostnameMode = HostnameMode.IP;
    else if (install.requestedHostnameMode === 'domain')
      domainHints.hostnameMode = HostnameMode.DOMAIN;

    if (install.requestedCertificateProvider === 'lets-encrypt')
      domainHints.certificateProvider = CertificateProvider.LETS_ENCRYPT;
    else if (install.requestedCertificateProvider === 'lets-encrypt-staging')
      domainHints.certificateProvider =
        CertificateProvider.LETS_ENCRYPT_STAGING;

    // Install param (requestedTls) wins over the manifest's domain.tls.
    const certificateRequired =
      (install.requestedTls ?? spec.domain?.tls) !== false;

    try {
      const endpoint = await this.appEndpointService.createEndpoint(
        install.clusterId,
        {
          applicationId,
          fqdn: install.requestedDomain,
          clusterDnsZoneId: assignment?.id,
          certificateRequired,
          ...domainHints,
        },
      );
      await this.installRepo.update(install.id, {
        resolvedFqdn: endpoint.fqdn,
      });
      this.logger.log(
        `Install ${install.id}: endpoint created fqdn=${endpoint.fqdn} mode=${endpoint.hostnameMode}/${endpoint.certChallenge} tls=${certificateRequired}`,
      );

      // Reconciliation is idempotent and can take a few seconds (DNS record
      // creation on the provider + Ingress apply on the cluster). Fire and
      // forget: if it errors we log, the endpoint row stays PENDING and the
      // UI can retry via POST /clusters/:id/app-endpoints/:id/reconcile.
      void this.appEndpointReconciliationService
        .reconcile(endpoint.id)
        .catch((err) =>
          this.logger.warn(
            `Endpoint reconciliation failed for ${endpoint.id} (install ${install.id}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
    } catch (err) {
      this.logger.warn(
        `Endpoint provisioning failed for install ${install.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private mapDomainSpecToEndpointDto(
    domain: CatalogDomainSpec | undefined,
    fallbackCertProvider: CertificateProvider | undefined,
  ): {
    hostnameMode?: HostnameMode;
    certChallenge?: CertChallenge;
    certificateProvider?: CertificateProvider;
  } {
    let hostnameMode: HostnameMode | undefined;
    if (domain?.hostnameMode === 'ip') hostnameMode = HostnameMode.IP;
    else if (domain?.hostnameMode === 'domain')
      hostnameMode = HostnameMode.DOMAIN;

    let certChallenge: CertChallenge | undefined;
    if (domain?.certChallenge === 'http-01')
      certChallenge = CertChallenge.HTTP_01;
    else if (domain?.certChallenge === 'dns-01')
      certChallenge = CertChallenge.DNS_01;

    let certificateProvider: CertificateProvider | undefined;
    if (domain?.certificateProvider === 'lets-encrypt-staging') {
      certificateProvider = CertificateProvider.LETS_ENCRYPT_STAGING;
    } else if (domain?.certificateProvider === 'lets-encrypt') {
      certificateProvider = CertificateProvider.LETS_ENCRYPT;
    } else {
      certificateProvider = fallbackCertProvider;
    }

    return { hostnameMode, certChallenge, certificateProvider };
  }

  private buildImageRef(image: CatalogImageSource): string {
    if (image.source) {
      throw new Error('Build-from-git images are not supported in Iteration 1');
    }
    const registry = image.registry ?? 'docker.io';
    const repository = image.repository ?? '';
    const tag = image.tag ?? 'latest';
    if (!repository) {
      throw new Error('image.repository is required');
    }
    const prefix = registry === 'docker.io' ? '' : `${registry}/`;
    return `${prefix}${repository}:${tag}`;
  }

  private mapVolumes(
    volumes: CatalogVolume[] | undefined,
  ): CreateApplicationDto['volumes'] {
    if (!volumes?.length) return [];
    return volumes.map((v) => ({
      name: v.name,
      mountPath: v.mountPath,
      size: v.size ?? '1Gi',
    }));
  }

  private mapResources(r: CatalogResources): CreateApplicationDto['resources'] {
    return {
      cpu: {
        request: r.requests?.cpu,
        limit: r.limits?.cpu,
      },
      memory: {
        request: r.requests?.memory,
        limit: r.limits?.memory,
      },
    };
  }

  /**
   * Merge user-supplied resource overrides onto the manifest defaults.
   * Each field is individually overridable; omitted fields keep the default.
   * Used when the install request includes `resourceOverrides` to let users
   * scale down on constrained clusters or bump up preventively.
   */
  private applyResourceOverrides(
    base: CreateApplicationDto['resources'],
    overrides: CatalogInstallEntity['resourceOverrides'],
  ): CreateApplicationDto['resources'] {
    if (!overrides) return base;
    return {
      cpu: {
        request: overrides.cpu?.request ?? base?.cpu?.request,
        limit: overrides.cpu?.limit ?? base?.cpu?.limit,
      },
      memory: {
        request: overrides.memory?.request ?? base?.memory?.request,
        limit: overrides.memory?.limit ?? base?.memory?.limit,
      },
    };
  }

  /**
   * Initial replica count for the Deployment. User override wins; otherwise
   * use the manifest's horizontal.min when HPA is enabled, else 1.
   */
  private resolveReplicas(
    spec: CatalogSpecStandalone | CatalogSpecBuildingBlock,
    overrides: CatalogInstallEntity['resourceOverrides'],
  ): number {
    if (overrides?.replicas !== undefined) return overrides.replicas;
    if (spec.scaling.horizontal.enabled) {
      return spec.scaling.horizontal.min ?? 1;
    }
    return 1;
  }

  private mapScaling(s: CatalogScaling): ApplicationScaling {
    const horizontal = {
      enabled: s.horizontal.enabled,
      min: s.horizontal.min,
      max: s.horizontal.max,
      metrics: s.horizontal.metrics?.map((m) => ({
        type: m.type === 'custom' ? 'cpu' : m.type,
        utilization: m.target.value,
      })),
      behavior: s.horizontal.behavior
        ? {
            scaleUp: s.horizontal.behavior.scaleUp
              ? {
                  stabilizationWindowSeconds: this.parseDurationSeconds(
                    s.horizontal.behavior.scaleUp.stabilizationWindow,
                  ),
                  step: s.horizontal.behavior.scaleUp.step,
                }
              : undefined,
            scaleDown: s.horizontal.behavior.scaleDown
              ? {
                  stabilizationWindowSeconds: this.parseDurationSeconds(
                    s.horizontal.behavior.scaleDown.stabilizationWindow,
                  ),
                  step: s.horizontal.behavior.scaleDown.step,
                }
              : undefined,
          }
        : undefined,
    };

    const vertical = {
      enabled: s.vertical.enabled,
      mode: (s.vertical.mode ?? 'Off') as
        | 'Off'
        | 'Initial'
        | 'Recreate'
        | 'Auto',
      bounds: s.vertical.bounds,
      updatePolicy: s.vertical.updatePolicy
        ? {
            trigger: s.vertical.updatePolicy.trigger,
            cooldownSeconds: s.vertical.updatePolicy.cooldown
              ? this.parseDurationSeconds(s.vertical.updatePolicy.cooldown)
              : undefined,
          }
        : undefined,
    };

    const firstCpuMetric = s.horizontal.metrics?.find((m) => m.type === 'cpu');
    const firstMemoryMetric = s.horizontal.metrics?.find(
      (m) => m.type === 'memory',
    );

    return {
      enabled: s.horizontal.enabled,
      minReplicas: s.horizontal.min,
      maxReplicas: s.horizontal.max,
      targetCPU: firstCpuMetric?.target.value,
      targetMemory: firstMemoryMetric?.target.value,
      horizontal,
      vertical,
    };
  }

  /**
   * Resolve `{{env.X}}` / `{{app.Y}}` placeholders that appear inside a
   * healthcheck block (command args, http path, etc.). Env values and
   * template-only fields in `spec.env` already go through the resolver
   * upstream; healthchecks were missed in Iter 1 because they're out of the
   * env loop. Without this pass, a probe like
   *   exec: { command: ["pg_isready", "-U", "{{env.POSTGRES_USER}}"] }
   * reaches the pod with the literal "{{env.POSTGRES_USER}}" and the probe
   * always fails (pg_isready treats it as a user name).
   */
  private resolveHealthcheckTemplates(
    hc: CatalogHealthcheck | undefined,
    ctx: TemplateContext,
  ): CatalogHealthcheck | undefined {
    if (!hc) return hc;
    const resolved: CatalogHealthcheck = { ...hc };
    if (hc.command) {
      resolved.command = hc.command.map((p) =>
        this.templateResolver.resolve(p, ctx),
      );
    }
    if (hc.path) {
      resolved.path = this.templateResolver.resolve(hc.path, ctx);
    }
    return resolved;
  }

  private mapHealthProbe(
    hc: CatalogHealthcheck | undefined,
    port?: number,
  ): ApplicationHealthProbe | undefined {
    if (!hc) return undefined;
    const base: ApplicationHealthProbe = {
      type: hc.type,
      initialDelaySeconds: hc.initialDelay
        ? this.parseDurationSeconds(hc.initialDelay)
        : 30,
      periodSeconds: hc.interval ? this.parseDurationSeconds(hc.interval) : 10,
      timeoutSeconds: hc.timeout ? this.parseDurationSeconds(hc.timeout) : 5,
      failureThreshold: hc.retries ?? 3,
    };
    if (hc.type === 'http') {
      return {
        ...base,
        httpPath: hc.path ?? '/',
        httpPort: hc.port ?? port ?? 80,
        ...(hc.httpHeaders ? { httpHeaders: hc.httpHeaders } : {}),
      };
    }
    if (hc.type === 'tcp') {
      return { ...base, tcpPort: hc.port ?? port ?? 80 };
    }
    if (hc.type === 'exec') {
      return { ...base, execCommand: hc.command ?? [] };
    }
    return base;
  }

  private parseDurationSeconds(value: string): number {
    const match = /^(\d+)\s*([smh])?$/.exec(value.trim());
    if (!match) {
      throw new Error(
        `Invalid duration "${value}"; expected "60s", "5m", "1h"`,
      );
    }
    const n = Number.parseInt(match[1], 10);
    const unit = match[2] ?? 's';
    if (unit === 's') return n;
    if (unit === 'm') return n * 60;
    if (unit === 'h') return n * 3600;
    return n;
  }

  private async waitForDeployOperation(
    operationId: string,
    applicationId: string,
    timeoutMs: number,
    pollMs: number,
  ): Promise<{ ok: boolean; error?: string }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const op = await this.operationRepo.findOne({
        where: { id: operationId },
      });
      if (!op) return { ok: false, error: 'deploy operation not found' };
      if (op.status === OperationStatus.COMPLETED) {
        const app = await this.applicationRepo.findById(applicationId);
        if (app?.status === ApplicationStatus.RUNNING) {
          return { ok: true };
        }
      }
      if (op.status === OperationStatus.FAILED) {
        return { ok: false, error: op.errorMessage ?? 'deploy failed' };
      }
      await this.sleep(pollMs);
    }
    return {
      ok: false,
      error: `deploy did not complete within ${timeoutMs}ms`,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async updateOperation(
    operationId: string,
    status: OperationStatus,
    progress?: number,
    currentStep?: OperationStep,
    errorMessage?: string,
  ): Promise<void> {
    const updateData: Partial<InfrastructureOperationEntity> = { status };
    if (progress !== undefined) updateData.progress = progress;
    if (currentStep !== undefined) updateData.currentStep = currentStep;
    if (errorMessage) updateData.errorMessage = errorMessage;
    if (status === OperationStatus.IN_PROGRESS) {
      updateData.startedAt = new Date();
    }
    if (
      status === OperationStatus.COMPLETED ||
      status === OperationStatus.FAILED
    ) {
      updateData.completedAt = new Date();
    }
    await this.operationRepo.update(operationId, updateData);
  }

  /**
   * Iter 4: composed stack install. Creates N applications (one per component)
   * in topological order, wires inter-component discovery via K8s DNS, and
   * provisions a single public endpoint on the component that declares an
   * exposed port. Each component can reference preceding ones via
   * `{{components.NAME.host}}` / `{{components.NAME.env.VAR}}` template paths.
   */
  private async handleComposedInstall(
    install: CatalogInstallEntity,
    definition: CatalogAppDefinitionEntity,
    spec: CatalogSpecComposed,
    operationId: string,
  ): Promise<void> {
    const includedComponents = spec.components.filter((c) =>
      this.componentIncluded(c, install, spec),
    );
    const order = this.topologicallySortComponents(includedComponents);

    await this.updateOperation(
      operationId,
      OperationStatus.IN_PROGRESS,
      20,
      OperationStep.CATALOG_INSTALL_CREATE_APPLICATIONS,
    );

    const namespace = install.userEmail
      ? buildUserNamespace(install.userEmail)
      : 'default';
    const ctx: TemplateContext = {
      app: {
        id: install.slug,
        slug: install.slug,
        domain: install.requestedDomain,
        namespace,
      },
      env: {},
      components: {},
    };

    const applicationIds: string[] = [];
    const degradedComponents: string[] = [];
    const primaryComponent = this.pickPrimaryComponent(includedComponents);
    const appIdByComponent = new Map<string, string>();

    const cluster = await this.clusterRepository.findOne({
      where: { id: install.clusterId },
    });
    const zoneAssignment = install.requestedDomain
      ? await this.clusterDnsZoneService.getZoneForFqdn(
          install.clusterId,
          install.requestedDomain,
        )
      : await this.clusterDnsZoneService.getZoneAssignment(install.clusterId);
    const componentFqdns: Record<string, string> = {};
    if (cluster && !install.skipEndpoint && spec.domain?.auto !== false) {
      for (const c of includedComponents) {
        if (!(c.ports ?? []).some((p) => p.expose)) continue;
        const requestedFqdn =
          c === primaryComponent
            ? (install.requestedDomain ?? undefined)
            : undefined;
        componentFqdns[c.name] = this.endpointModeResolver.resolve({
          cluster,
          clusterDnsZone: zoneAssignment ?? null,
          requestedFqdn,
          slug: `${install.slug}-${c.name}`,
        }).fqdn;
      }
    }

    // Pre-populate every component's host/fqdn (deterministic from slug+namespace)
    // so siblings can cross-reference regardless of deploy order. `env` stays empty
    // until each deploys, so secret refs still require the producer first.
    for (const c of includedComponents) {
      ctx.components[c.name] = {
        host: `${install.slug}-${c.name}-svc.${namespace}.svc.cluster.local`,
        fqdn: componentFqdns[c.name],
        env: {},
      };
    }

    const existingApps = await this.applicationRepo.findByCatalogInstall(
      install.id,
    );
    const existingByComponent = new Map(
      existingApps
        .map((a) => [a.labels?.['flui.cloud/composed-component'], a] as const)
        .filter(([name]) => !!name) as Array<
        readonly [string, (typeof existingApps)[number]]
      >,
    );

    for (let i = 0; i < order.length; i++) {
      const component = order[i];
      const componentSlug = `${install.slug}-${component.name}`;

      const resolvedEnv = this.resolveEnv(component.env, install);
      const componentEnvMap = Object.fromEntries(
        resolvedEnv.map((e) => [e.name, e.value]),
      );
      const componentCtx: TemplateContext = {
        ...ctx,
        env: componentEnvMap,
        self: {
          host: `${componentSlug}-svc.${namespace}.svc.cluster.local`,
          fqdn: componentFqdns[component.name],
          env: componentEnvMap,
        },
      };
      const substituted = resolvedEnv.map((e) => ({
        name: e.name,
        value: this.templateResolver.resolve(e.value, componentCtx),
        secret: e.secret,
        externalSecretRef: e.externalSecretRef,
      }));

      const reused = existingByComponent.get(component.name);
      let application: ApplicationEntity;
      if (reused) {
        application = reused;
        this.logger.log(
          `Install ${install.id}: reusing existing component "${component.name}" (${reused.id}) — idempotent re-entry`,
        );
      } else {
        const dto = this.buildComponentCreateDto(
          definition,
          install,
          component,
          componentSlug,
          namespace,
          substituted,
        );
        application = await this.applicationService.create(
          install.clusterId,
          dto,
          install.userId,
          install.userEmail,
        );
      }
      applicationIds.push(application.id);
      appIdByComponent.set(component.name, application.id);
      await this.installRepo.update(install.id, { applicationIds });

      const progress = 20 + Math.floor((60 * (i + 1)) / order.length);
      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        progress,
        OperationStep.CATALOG_INSTALL_DEPLOY_COMPONENTS,
      );

      const imageRef = this.buildImageRef(component.image);
      const deployOp = await this.deployService.triggerDeployWithImage(
        application.id,
        imageRef,
        install.userId,
      );
      const deployResult = await this.waitForDeployOperation(
        deployOp.id,
        application.id,
        this.deployConfig.getCatalogInstallWaitTimeoutMs(),
        this.deployConfig.getCatalogInstallPollIntervalMs(),
      );
      if (!deployResult.ok) {
        // An optional component (when.option) that fails readiness must not abort
        // the install — that would block the primary app's endpoint + postInstall
        // and leave it misconfigured. Degrade it; required components still fail.
        if (component.when?.option) {
          this.logger.warn(
            `Install ${install.id}: optional component "${component.name}" did not become ready (${deployResult.error ?? 'unknown'}) — continuing without it; its feature stays unavailable until it recovers.`,
          );
          degradedComponents.push(component.name);
        } else {
          throw new Error(
            `Deploy failed for component ${component.name} (app ${application.id}): ${deployResult.error ?? 'unknown'}`,
          );
        }
      }

      // Service DNS resolves as soon as the Service exists (independent of pod
      // readiness), so still expose the component to later template contexts.
      ctx.components[component.name] = {
        host: `${application.slug}-svc.${namespace}.svc.cluster.local`,
        env: Object.fromEntries(substituted.map((e) => [e.name, e.value])),
        fqdn: componentFqdns[component.name],
      };
    }

    await this.updateOperation(
      operationId,
      OperationStatus.IN_PROGRESS,
      85,
      OperationStep.CATALOG_INSTALL_CREATE_ENDPOINTS,
    );

    if (primaryComponent && applicationIds.length) {
      for (const component of order) {
        if (!(component.ports ?? []).some((p) => p.expose)) continue;
        const appId = appIdByComponent.get(component.name);
        if (!appId) continue;
        await this.createComposedComponentEndpoint(
          install,
          appId,
          spec,
          component,
          component === primaryComponent,
          componentFqdns[component.name],
        );
      }

      const primaryAppId = appIdByComponent.get(primaryComponent.name)!;
      // SSO wiring is best-effort (HTTP call to the OIDC provider): a slow or
      // unreachable provider must not abort an otherwise-deployed install.
      // Degrade SSO; reconcile re-runs it.
      let oidc: OidcWireResult | null = null;
      try {
        oidc = await this.maybeWireComposedOidc(
          install,
          spec,
          primaryComponent,
          primaryAppId,
          appIdByComponent,
        );
      } catch (err) {
        this.logger.warn(
          `Install ${install.id}: SSO wiring failed (${err instanceof Error ? err.message : String(err)}) — continuing without SSO; retry/reconcile to enable it.`,
        );
        degradedComponents.push('sso');
      }
      await this.maybeRunPostInstall(
        install,
        spec,
        primaryAppId,
        oidc,
        ctx.components,
      );
    }

    await this.updateOperation(
      operationId,
      OperationStatus.IN_PROGRESS,
      95,
      OperationStep.CATALOG_INSTALL_FINALIZE,
    );
    await this.installRepo.updateStatus(
      install.id,
      CatalogInstallStatus.RUNNING,
    );
    if (degradedComponents.length) {
      this.logger.warn(
        `Install ${install.id}: completed with degraded optional components [${degradedComponents.join(', ')}] — core app is configured; retry/reconcile those components to enable their features.`,
      );
    }
    await this.updateOperation(
      operationId,
      OperationStatus.COMPLETED,
      100,
      OperationStep.CATALOG_INSTALL_FINALIZE,
    );
    this.logger.log(
      `Composed install ${install.id} completed (${order.length} components)`,
    );
  }

  private topologicallySortComponents(
    components: CatalogComponent[],
  ): CatalogComponent[] {
    const byName = new Map(components.map((c) => [c.name, c]));
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const out: CatalogComponent[] = [];
    const visit = (c: CatalogComponent) => {
      if (visited.has(c.name)) return;
      if (visiting.has(c.name)) {
        throw new Error(
          `Cyclic dependsOn detected in composed components at "${c.name}"`,
        );
      }
      visiting.add(c.name);
      for (const depName of c.dependsOn ?? []) {
        const dep = byName.get(depName);
        if (!dep) {
          throw new Error(
            `Component "${c.name}" dependsOn unknown component "${depName}"`,
          );
        }
        visit(dep);
      }
      visiting.delete(c.name);
      visited.add(c.name);
      out.push(c);
    };
    for (const c of components) visit(c);
    return out;
  }

  private pickPrimaryComponent(
    components: CatalogComponent[],
  ): CatalogComponent | undefined {
    return components.find((c) => (c.ports ?? []).some((p) => p.expose));
  }

  private isOptionEnabled(
    install: CatalogInstallEntity,
    spec: CatalogSpecComposed,
    key: string,
  ): boolean {
    const chosen = install.options?.[key];
    if (typeof chosen === 'boolean') return chosen;
    return spec.options?.find((o) => o.key === key)?.default ?? false;
  }

  private componentIncluded(
    component: CatalogComponent,
    install: CatalogInstallEntity,
    spec: CatalogSpecComposed,
  ): boolean {
    const opt = component.when?.option;
    if (!opt) return true;
    return this.isOptionEnabled(install, spec, opt);
  }

  private buildComponentCreateDto(
    definition: CatalogAppDefinitionEntity,
    install: CatalogInstallEntity,
    component: CatalogComponent,
    componentSlug: string,
    namespace: string,
    env: ResolvedEnv[],
  ): CreateApplicationDto {
    const imageRef = this.buildImageRef(component.image);
    const primaryPort = component.ports?.[0];
    const exposedPort = (component.ports ?? []).find((p) => p.expose);
    const exposure: ApplicationExposure = exposedPort
      ? ApplicationExposure.PUBLIC
      : ApplicationExposure.CLUSTER;

    return {
      name: componentSlug,
      slug: componentSlug,
      description: definition.description,
      category: ApplicationCategory.USER,
      kind: definition.appKind ?? mapCatalogCategoryToKind(definition.category),
      sourceType: ApplicationSourceType.DOCKER_IMAGE,
      k8sNamespace: namespace,
      sourceConfig: {
        type: 'docker_image',
        imageRef,
        pullPolicy: 'IfNotPresent',
      },
      env: env.map((e) => ({
        name: e.name,
        value: e.value,
        secret: e.secret,
        externalSecretRef: e.externalSecretRef,
      })),
      resources: this.mapResources(component.resources),
      scaling: this.mapScaling(component.scaling),
      replicas: component.scaling.horizontal.enabled
        ? (component.scaling.horizontal.min ?? 1)
        : 1,
      port: primaryPort?.internal,
      portProtocol: primaryPort?.protocol,
      allowMasterPlacement:
        install.allowMasterPlacement ||
        process.env.FLUI_ALLOW_MASTER === 'true',
      healthProbe: component.healthcheck
        ? this.mapHealthProbe(component.healthcheck, primaryPort?.internal)
        : undefined,
      volumes: this.mapVolumes(component.volumes),
      workloadKind: (component.volumes ?? []).length
        ? 'StatefulSet'
        : 'Deployment',
      persistenceScope: component.persistence?.scope ?? 'shared',
      securityContext: component.securityContext,
      startCommand: component.startCommand,
      command: component.command,
      configFiles: component.configFiles,
      labels: {
        'flui.cloud/catalog-app': definition.slug,
        'flui.cloud/catalog-install': install.id,
        'flui.cloud/app-type': definition.appType,
        'flui.cloud/composed-component': component.name,
        ...(component.engine && { 'flui.cloud/db-engine': component.engine }),
      },
      metadata: {
        catalogInstallId: install.id,
        catalogDefinitionId: definition.id,
        catalogVersion: definition.version,
        composedComponent: component.name,
      },
      exposure,
    };
  }

  private async createComposedComponentEndpoint(
    install: CatalogInstallEntity,
    applicationId: string,
    spec: CatalogSpecComposed,
    component: CatalogComponent,
    isPrimary: boolean,
    resolvedFqdn?: string,
  ): Promise<string | null> {
    if (install.skipEndpoint) {
      this.logger.log(
        `Composed install ${install.id}: skipEndpoint=true — user will configure domain/TLS later`,
      );
      return null;
    }
    if (spec.domain?.auto === false) {
      this.logger.log(
        `Composed install ${install.id}: domain.auto=false — skipping endpoint`,
      );
      return null;
    }
    const exposedPort = (component.ports ?? []).find((p) => p.expose);
    if (!exposedPort) return null;

    const requestedDomain = isPrimary ? install.requestedDomain : undefined;
    const assignment = requestedDomain
      ? await this.clusterDnsZoneService.getZoneForFqdn(
          install.clusterId,
          requestedDomain,
        )
      : await this.clusterDnsZoneService.getZoneAssignment(install.clusterId);
    const wildcardIssuer = assignment?.dnsZone?.zoneName
      ? await this.clusterDnsZoneService.resolveWildcardIssuer(
          install.clusterId,
        )
      : null;

    const domainHints = this.mapDomainSpecToEndpointDto(
      spec.domain,
      wildcardIssuer?.certificateProvider,
    );

    // Install params win over the manifest; http-01 forces a per-host cert even on a wildcard zone.
    if (install.requestedCertChallenge === 'http-01')
      domainHints.certChallenge = CertChallenge.HTTP_01;
    else if (install.requestedCertChallenge === 'dns-01')
      domainHints.certChallenge = CertChallenge.DNS_01;

    if (install.requestedHostnameMode === 'ip')
      domainHints.hostnameMode = HostnameMode.IP;
    else if (install.requestedHostnameMode === 'domain')
      domainHints.hostnameMode = HostnameMode.DOMAIN;

    if (install.requestedCertificateProvider === 'lets-encrypt')
      domainHints.certificateProvider = CertificateProvider.LETS_ENCRYPT;
    else if (install.requestedCertificateProvider === 'lets-encrypt-staging')
      domainHints.certificateProvider =
        CertificateProvider.LETS_ENCRYPT_STAGING;

    // Install param (requestedTls) wins over the manifest's domain.tls.
    const certificateRequired =
      (install.requestedTls ?? spec.domain?.tls) !== false;

    try {
      const endpoint = await this.appEndpointService.createEndpoint(
        install.clusterId,
        {
          applicationId,
          fqdn: resolvedFqdn ?? requestedDomain,
          clusterDnsZoneId: assignment?.id,
          certificateRequired,
          ...domainHints,
        },
      );
      if (isPrimary) {
        await this.installRepo.update(install.id, {
          resolvedFqdn: endpoint.fqdn,
        });
      }
      void this.appEndpointReconciliationService
        .reconcile(endpoint.id)
        .catch((err) =>
          this.logger.warn(
            `Composed endpoint reconciliation failed for ${endpoint.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      return endpoint.fqdn;
    } catch (err) {
      this.logger.warn(
        `Composed endpoint creation failed for component "${component.name}" of install ${install.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  private async maybeWireComposedOidc(
    install: CatalogInstallEntity,
    spec: CatalogSpecComposed,
    primaryComponent: CatalogComponent,
    primaryAppId: string,
    appIdByComponent: Map<string, string>,
  ): Promise<OidcWireResult | null> {
    const auth = spec.auth;
    const mode = install.authMode ?? auth?.default ?? auth?.mode ?? 'native';
    if (mode !== 'oidc') return null;
    if (!auth?.oidc) {
      this.logger.warn(
        `Install ${install.id}: authMode=oidc but spec.auth.oidc missing — skipping SSO wiring`,
      );
      return null;
    }
    const pat = process.env.ZITADEL_SERVICE_ACCOUNT_PAT;
    if (!pat) {
      this.logger.warn(
        `Install ${install.id}: ZITADEL_SERVICE_ACCOUNT_PAT not set — skipping SSO wiring`,
      );
      return null;
    }

    const fresh = await this.installRepo.findById(install.id);
    const fqdn = fresh?.resolvedFqdn;
    if (!fqdn) {
      this.logger.warn(
        `Install ${install.id}: no resolved FQDN — skipping SSO wiring`,
      );
      return null;
    }
    const cluster = await this.clusterRepository.findOne({
      where: { id: install.clusterId },
    });
    if (!cluster?.masterIpAddress) {
      this.logger.warn(
        `Install ${install.id}: cluster master IP missing — skipping SSO wiring`,
      );
      return null;
    }

    const providerDomain = buildSystemNipHostname(
      'auth',
      cluster.masterIpAddress,
      cluster.nipHostnameToken,
    );
    const issuer = `https://${providerDomain}`;
    const project = await this.oidcProvider.findProjectByName(
      pat,
      providerDomain,
      'Flui',
    );
    if (!project) {
      this.logger.warn(
        `Install ${install.id}: Flui OIDC project not found — skipping SSO wiring`,
      );
      return null;
    }

    const paths = auth.oidc.redirectPaths ?? ['/auth/login'];
    const redirectUris = paths.map((p) => `https://${fqdn}${p}`);
    const app = await this.oidcProvider.createWebOidcApp(
      pat,
      providerDomain,
      project.id,
      { name: install.slug, redirectUris },
    );
    this.logger.log(
      `Install ${install.id}: registered OIDC client ${app.clientId} for ${fqdn}`,
    );
    await this.installRepo.update(install.id, {
      oidcAppId: app.appId,
      oidcProjectId: project.id,
    });

    const result: OidcWireResult = {
      issuerUrl: issuer,
      clientId: app.clientId,
      clientSecret: app.clientSecret ?? '',
    };

    // OIDC env/config targets the component that speaks OIDC (may differ from the exposed one), else the primary.
    const targetName = auth.oidc.targetComponent;
    const targetAppId =
      (targetName && appIdByComponent.get(targetName)) || primaryAppId;
    const targetComponent =
      (targetName && spec.components.find((c) => c.name === targetName)) ||
      primaryComponent;

    const entity = await this.applicationRepo.findById(targetAppId);
    if (!entity) return result;
    const env = [...(entity.env ?? [])];
    let configFiles: Array<{ path: string; content: string }> | undefined;

    if (auth.oidc.configFile) {
      const cf = auth.oidc.configFile;
      const content = cf.template
        .replaceAll('{{oidc.issuerUrl}}', issuer)
        .replaceAll('{{oidc.clientId}}', app.clientId)
        .replaceAll('{{oidc.clientSecret}}', app.clientSecret ?? '');
      configFiles = [{ path: cf.path, content }];
      env.push({ name: cf.env, value: cf.path });
    } else if (auth.oidc.envMapping) {
      const m = auth.oidc.envMapping;
      if (m.issuerUrl) env.push({ name: m.issuerUrl, value: issuer });
      if (m.clientId) env.push({ name: m.clientId, value: app.clientId });
      if (m.clientSecret)
        env.push({ name: m.clientSecret, value: app.clientSecret ?? '' });
      if (m.enabledFlag) env.push({ name: m.enabledFlag, value: 'true' });
    }

    // OIDC-only extra env; replaces any same-named entry already present.
    if (auth.oidc.extraEnv) {
      for (const [name, value] of Object.entries(auth.oidc.extraEnv)) {
        const i = env.findIndex((e) => e.name === name);
        if (i >= 0) env[i] = { ...env[i], value };
        else env.push({ name, value });
      }
    }

    if (!configFiles && !auth.oidc.envMapping && !auth.oidc.extraEnv) {
      this.logger.log(
        `Install ${install.id}: OIDC client registered; ${primaryComponent.name} configured via postInstall — no redeploy`,
      );
      return result;
    }

    await this.applicationRepo.update(targetAppId, {
      env,
      ...(configFiles ? { configFiles } : {}),
    });

    const imageRef = this.buildImageRef(targetComponent.image);
    const op = await this.deployService.triggerDeployWithImage(
      targetAppId,
      imageRef,
      install.userId,
    );
    await this.waitForDeployOperation(
      op.id,
      targetAppId,
      this.deployConfig.getCatalogInstallWaitTimeoutMs(),
      this.deployConfig.getCatalogInstallPollIntervalMs(),
    );
    this.logger.log(
      `Install ${install.id}: SSO wired + ${targetComponent.name} redeployed`,
    );
    return result;
  }

  private async maybeRunPostInstall(
    install: CatalogInstallEntity,
    spec: CatalogSpecComposed,
    primaryAppId: string,
    oidc: OidcWireResult | null,
    components: Record<string, TemplateComponentContext> = {},
  ): Promise<void> {
    const steps = spec.postInstall ?? [];
    if (!steps.length) return;
    const mode =
      install.authMode ?? spec.auth?.default ?? spec.auth?.mode ?? 'native';
    const fresh = await this.installRepo.findById(install.id);
    const fqdn = fresh?.resolvedFqdn ?? '';

    const ctx: Record<string, string> = {
      'install.userEmail': install.userEmail ?? '',
      'install.resolvedFqdn': fqdn,
      'generate.password': `${randomUUID()}aA1!`,
      ...(oidc
        ? {
            'oidc.issuerUrl': oidc.issuerUrl,
            'oidc.clientId': oidc.clientId,
            'oidc.clientSecret': oidc.clientSecret,
          }
        : {}),
    };
    for (const [name, c] of Object.entries(components)) {
      if (c.host) ctx[`components.${name}.host`] = c.host;
      if (c.fqdn) ctx[`components.${name}.fqdn`] = c.fqdn;
    }
    const render = (s: string): string =>
      s.replace(/\{\{([^}]+)\}\}/g, (_, k) => ctx[k.trim()] ?? '');

    for (const step of steps) {
      if (!this.postInstallStepMatches(step, mode, install, spec)) continue;
      if (step.exec) {
        await this.runPostInstallExec(install, primaryAppId, step, render);
      } else if (step.http) {
        await this.runPostInstallHttp(install, fqdn, step, render);
      }
    }
  }

  private async runPostInstallHttp(
    install: CatalogInstallEntity,
    fqdn: string,
    step: CatalogPostInstallStep,
    render: (s: string) => string,
  ): Promise<void> {
    if (!step.http) return;
    if (!fqdn) {
      this.logger.warn(
        `Install ${install.id}: postInstall "${step.name}" needs an endpoint but none resolved — skipping`,
      );
      return;
    }
    const expect = step.http.expectStatus ?? [200, 201];
    try {
      const resp = await fetch(`http://${fqdn}${step.http.path}`, {
        method: step.http.method,
        headers: {
          'Content-Type': 'application/json',
          ...(step.http.headers ?? {}),
        },
        body: step.http.body ? render(step.http.body) : undefined,
      });
      this.logger.log(
        `Install ${install.id}: postInstall "${step.name}" → ${resp.status} (${
          expect.includes(resp.status) ? 'ok' : 'unexpected'
        })`,
      );
    } catch (err) {
      this.logger.warn(
        `Install ${install.id}: postInstall "${step.name}" failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async runPostInstallExec(
    install: CatalogInstallEntity,
    primaryAppId: string,
    step: CatalogPostInstallStep,
    render: (s: string) => string,
  ): Promise<void> {
    if (!step.exec) return;
    const app = await this.applicationRepo.findById(primaryAppId);
    if (!app) {
      this.logger.warn(
        `Install ${install.id}: postInstall "${step.name}" — primary app not found, skipping`,
      );
      return;
    }
    const command = step.exec.command.map(render);
    const container = step.exec.container ?? app.slug;
    try {
      const kubeconfig = await this.getClusterKubeconfigContent(
        install.clusterId,
      );
      const out = await this.kubernetesService.execInPod(
        kubeconfig,
        app.k8sNamespace,
        `flui-app-id=${primaryAppId}`,
        container,
        command,
      );
      this.logger.log(
        `Install ${install.id}: postInstall "${step.name}" exec ok${
          out?.trim() ? ` — ${out.trim().slice(0, 200)}` : ''
        }`,
      );
    } catch (err) {
      this.logger.warn(
        `Install ${install.id}: postInstall "${step.name}" exec failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async getClusterKubeconfigContent(
    clusterId: string,
  ): Promise<string> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new Error(`Kubeconfig not available for cluster ${clusterId}`);
    }
    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );
    const override = process.env.KUBECONFIG_SERVER_OVERRIDE;
    if (!override) return kubeconfig;
    // Same scoping as KubernetesService.patchKubeconfigServer: an optional
    // match keeps a multi-cluster dev setup from hijacking every cluster.
    const match = process.env.KUBECONFIG_SERVER_OVERRIDE_MATCH;
    return kubeconfig.replaceAll(/server:\s*https?:\/\/[^\s]+/g, (line) =>
      !match || line.includes(match) ? `server: ${override}` : line,
    );
  }

  private postInstallStepMatches(
    step: CatalogPostInstallStep,
    mode: string,
    install: CatalogInstallEntity,
    spec: CatalogSpecComposed,
  ): boolean {
    const authGate = step.when?.authMode;
    if (authGate !== undefined) {
      const ok = Array.isArray(authGate)
        ? authGate.includes(mode as never)
        : authGate === mode;
      if (!ok) return false;
    }
    const optionGate = step.when?.option;
    if (optionGate && !this.isOptionEnabled(install, spec, optionGate)) {
      return false;
    }
    return true;
  }
}
