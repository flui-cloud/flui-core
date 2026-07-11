import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { RepositoriesRepository } from '../../repositories/repositories/repositories.repository';
import { GitHubOAuthService } from '../../repositories/services/github-oauth.service';
import { GitHubAppService } from '../../repositories/services/github-app.service';
import { GithubAppUserAuthService } from '../../repositories/services/github-app-user-auth.service';
import { GhcrPackagesService } from '../../repositories/services/ghcr-packages.service';
import { ApplicationWorkflowService } from './application-workflow.service';
import { ApplicationService } from './application.service';
import { ApplicationDeployService } from './application-deploy.service';
import { ApplicationManifest } from '../interfaces/application-manifest.interface';
import { validateApplicationManifest } from '../utils/application-manifest.util';
import { ApplicationManifestEnvVar } from '@flui-cloud/spec';
import { ApplicationEnvVar } from '../interfaces/source-config.interface';
import { mergeAppEnv } from '../utils/env-merge.util';
import {
  DeployFromYamlDto,
  DeployFromYamlResponseDto,
} from '../dto/deploy-from-yaml.dto';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import { ApplicationCategory } from '../enums/application-category.enum';
import { ApplicationExposure } from '../enums/application-exposure.enum';
import { AppEndpointService } from '../../dns/services/app-endpoint.service';
import { AppEndpointReconciliationService } from '../../dns/services/app-endpoint-reconciliation.service';
import { ClusterDnsZoneService } from '../../dns/services/cluster-dns-zone.service';
import { HostnameMode } from '../../dns/enums/hostname-mode.enum';
import { CertChallenge } from '../../dns/enums/cert-challenge.enum';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';

const ENDPOINT_SPEC_METADATA_KEY = 'flui.endpoint.spec';

@Injectable()
export class ApplicationSourceDeployService {
  private readonly logger = new Logger(ApplicationSourceDeployService.name);

  constructor(
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly repositoriesRepository: RepositoriesRepository,
    private readonly githubOAuthService: GitHubOAuthService,
    private readonly githubAppService: GitHubAppService,
    private readonly githubAppUserAuthService: GithubAppUserAuthService,
    private readonly ghcrPackagesService: GhcrPackagesService,
    private readonly applicationWorkflowService: ApplicationWorkflowService,
    private readonly applicationService: ApplicationService,
    @Inject(forwardRef(() => ApplicationDeployService))
    private readonly applicationDeployService: ApplicationDeployService,
    @Inject(forwardRef(() => AppEndpointService))
    private readonly appEndpointService: AppEndpointService,
    @Inject(forwardRef(() => AppEndpointReconciliationService))
    private readonly appEndpointReconciliationService: AppEndpointReconciliationService,
    @Inject(forwardRef(() => ClusterDnsZoneService))
    private readonly clusterDnsZoneService: ClusterDnsZoneService,
  ) {}

  async deployFromYaml(
    userId: string,
    dto: DeployFromYamlDto,
  ): Promise<DeployFromYamlResponseDto> {
    const manifest = this.parseAndValidate(dto.yaml);

    if (dto.validateOnly) {
      return {
        applicationId: '',
        slug: '',
        name: manifest.metadata.name,
        status: 'valid',
      };
    }

    await this.assertGitHubConnected(userId);
    await this.assertGhcrPatPresent(userId);

    const branch = dto.branch ?? 'main';
    const [owner, repoName] = dto.repoFullName.split('/');
    if (!owner || !repoName) {
      throw new BadRequestException(
        `Invalid repoFullName "${dto.repoFullName}". Expected format: owner/repo`,
      );
    }

    const repository =
      await this.repositoriesRepository.findByUserIdAndFullName(
        userId,
        dto.repoFullName,
      );
    if (!repository) {
      throw new NotFoundException(
        `Repository "${dto.repoFullName}" is not connected to your account. ` +
          `Connect it first from the Flui dashboard or with \`flui repo connect\`.`,
      );
    }

    const buildPaths = this.resolveBuildPaths(manifest);

    let app = await this.findExistingApp(
      dto.clusterId,
      repository.id,
      branch,
      manifest.metadata.name,
    );

    // Resolve the imageRef to use when skipping the build:
    //   1. dto.imageRef (explicit) — wins
    //   2. app.imageRef (--no-build on existing app)
    //   3. GHCR latest tag for {owner}/{repoName} (--no-build, app deleted/missing)
    const skipBuild = dto.skipBuild === true || !!dto.imageRef;
    const resolvedImageRef = skipBuild
      ? await this.resolveSkipBuildImageRef({
          userId,
          dto,
          app,
          owner,
          repoName,
          subPath: buildPaths.subPath,
        })
      : null;

    const manifestEnv = this.buildManifestEnv(manifest);
    const resources = this.resolveResources(manifest);
    const healthProbe = manifest.deploy.healthcheck
      ? {
          type: 'http' as const,
          httpPath: manifest.deploy.healthcheck.path,
          httpPort: manifest.deploy.healthcheck.port ?? manifest.deploy.port,
          httpScheme: 'HTTP' as const,
        }
      : { type: 'none' as const };

    const sourceConfig = {
      type: 'git_build' as const,
      repositoryId: repository.id,
      branch,
      gitUrl: repository.cloneUrl,
      dockerfile: buildPaths.dockerfile,
      context: buildPaths.context,
      ...(buildPaths.subPath ? { subPath: buildPaths.subPath } : {}),
    };

    const endpointSpecJson = manifest.deploy.domain
      ? JSON.stringify(manifest.deploy.domain)
      : undefined;

    if (!app) {
      this.logger.log(
        `Creating new application from manifest: ${manifest.metadata.name}`,
      );
      app = await this.applicationService.create(
        dto.clusterId,
        {
          name: manifest.metadata.name,
          category: ApplicationCategory.USER,
          sourceType: ApplicationSourceType.GIT_BUILD,
          sourceConfig,
          port: manifest.deploy.port,
          exposure:
            (manifest.deploy.exposure as ApplicationExposure) ??
            ApplicationExposure.PUBLIC,
          env: mergeAppEnv([], manifestEnv, dto.envOverrides),
          resources,
          healthProbe: healthProbe as any,
          startCommand: manifest.deploy.startCommand,
          volumes: (manifest.deploy.volumes as any) ?? [],
          autoDeploy: false,
          metadata: endpointSpecJson
            ? { [ENDPOINT_SPEC_METADATA_KEY]: endpointSpecJson }
            : undefined,
        },
        userId,
      );
    } else {
      this.logger.log(`Updating existing application from manifest: ${app.id}`);

      const updatedMetadata = endpointSpecJson
        ? {
            ...app.metadata,
            [ENDPOINT_SPEC_METADATA_KEY]: endpointSpecJson,
          }
        : app.metadata;

      await this.applicationsRepository.update(app.id, {
        sourceConfig: sourceConfig as any,
        port: manifest.deploy.port,
        exposure:
          (manifest.deploy.exposure as ApplicationExposure) ?? app.exposure,
        env: mergeAppEnv(
          (app.env as ApplicationEnvVar[]) ?? [],
          manifestEnv,
          dto.envOverrides,
        ),
        resources: resources,
        healthProbe: healthProbe as any,
        startCommand: manifest.deploy.startCommand ?? null,
        metadata: updatedMetadata,
      });

      app = await this.applicationsRepository.findById(app.id);
    }

    if (skipBuild && resolvedImageRef) {
      const reason = dto.imageRef
        ? `flui deploy --image ${dto.imageRef}`
        : 'flui deploy --no-build (config-only update)';
      this.logger.log(
        `skipBuild: deploying ${app.slug} with imageRef=${resolvedImageRef}`,
      );
      const operation = await this.applicationDeployService.deploy(app.id, {
        imageRef: resolvedImageRef,
        reason,
      });
      return {
        applicationId: app.id,
        slug: app.slug,
        name: app.name,
        status: 'PROVISIONING',
        operationId: operation.id,
      };
    }

    const workflowResult =
      await this.applicationWorkflowService.generateAndCommitWorkflowV3(
        app.id,
        userId,
        {
          branch,
          isFluiManaged: true,
          dockerfilePath: buildPaths.dockerfile,
          buildContext: buildPaths.context,
          subPath: buildPaths.subPath,
        },
      );

    return {
      applicationId: app.id,
      slug: app.slug,
      name: app.name,
      status: 'AWAITING_BUILD',
      workflowUrl: workflowResult.workflowUrl,
      workflowRunUrl: workflowResult.runId
        ? `https://github.com/${dto.repoFullName}/actions/runs/${workflowResult.runId}`
        : undefined,
    };
  }

  private parseAndValidate(raw: string): ApplicationManifest {
    const { manifest, warnings } = validateApplicationManifest(raw);
    for (const w of warnings) {
      this.logger.warn(`manifest ${w.path}: ${w.message}`);
    }
    return manifest;
  }

  /**
   * App identity for manifest deploys = (cluster, repository, branch, name).
   * The name is part of the key so a monorepo can host several Applications
   * on the same branch (one flui.yaml per deployable). Renaming metadata.name
   * therefore creates a new app — like renaming a Helm release.
   */
  private async findExistingApp(
    clusterId: string,
    repositoryId: string,
    branch: string,
    name: string,
  ) {
    const apps = await this.applicationsRepository.findByClusterId(clusterId);
    return (
      apps.find((a) => {
        const cfg = a.sourceConfig as {
          type?: string;
          repositoryId?: string;
          branch?: string;
        } | null;
        return (
          cfg?.type === 'git_build' &&
          cfg.repositoryId === repositoryId &&
          cfg.branch === branch &&
          a.name === name
        );
      }) ?? null
    );
  }

  /**
   * Normalizes manifest build paths to repo-root-relative form and derives the
   * monorepo sub-path (used for the GHCR image segment and the workflow paths
   * filter). Single-app repos (context '.', root Dockerfile) yield no subPath.
   */
  private resolveBuildPaths(manifest: ApplicationManifest): {
    dockerfile: string;
    context: string;
    subPath?: string;
  } {
    const normalize = (p: string): string => {
      const v = p.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
      return v === '' ? '.' : v;
    };
    const context = normalize(manifest.build?.context ?? '.');
    const dockerfile = normalize(
      manifest.build?.dockerfile ??
        (context === '.' ? 'Dockerfile' : `${context}/Dockerfile`),
    );
    const dockerfileDir = dockerfile.includes('/')
      ? dockerfile.slice(0, dockerfile.lastIndexOf('/'))
      : '.';
    const subPath =
      context !== '.'
        ? context
        : dockerfileDir !== '.'
          ? dockerfileDir
          : undefined;
    return { dockerfile, context, subPath };
  }

  /** Env declared by the flui.yaml, tagged `manifest` so a deploy only owns these keys. */
  private buildManifestEnv(manifest: ApplicationManifest): ApplicationEnvVar[] {
    return (manifest.deploy.env ?? [])
      .map((e) => this.manifestEnvVar(e))
      .filter((e): e is ApplicationEnvVar => e !== null);
  }

  private manifestEnvVar(
    e: ApplicationManifestEnvVar,
  ): ApplicationEnvVar | null {
    // `valueFrom.secretRef: "<secretName>/<KEY>"` → a k8s secretKeyRef the pod
    // reads at runtime; the value never touches Flui's DB or the repo.
    const ref = e.valueFrom?.secretRef;
    if (ref) {
      const slash = ref.lastIndexOf('/');
      if (slash <= 0 || slash === ref.length - 1) {
        this.logger.warn(
          `env "${e.name}": secretRef "${ref}" must be "<secretName>/<KEY>" — ignored`,
        );
        return null;
      }
      return {
        name: e.name,
        value: '',
        source: 'manifest',
        externalSecretRef: {
          secretName: ref.slice(0, slash),
          key: ref.slice(slash + 1),
        },
      };
    }
    if (e.value === undefined) return null;
    return {
      name: e.name,
      value: e.value,
      source: 'manifest',
      ...(e.secret ? { secret: true } : {}),
    };
  }

  private resolveResources(manifest: ApplicationManifest) {
    const r = manifest.deploy.resources;
    if (!r) return undefined;
    if (r.requests || r.limits) {
      return { requests: r.requests, limits: r.limits } as any;
    }
    return undefined;
  }

  private async resolveSkipBuildImageRef(opts: {
    userId: string;
    dto: DeployFromYamlDto;
    app: { imageRef?: string | null } | null | undefined;
    owner: string;
    repoName: string;
    /** Monorepo image segment: package is {repoName}/{subPath} on GHCR. */
    subPath?: string;
  }): Promise<string> {
    const { userId, dto, app, owner, repoName, subPath } = opts;
    if (dto.imageRef) return dto.imageRef;
    if (app?.imageRef) return app.imageRef;

    const packageName = subPath
      ? `${repoName}/${subPath}`.toLowerCase()
      : repoName;
    const latest = await this.ghcrPackagesService.getLatestTag(
      userId,
      owner,
      packageName,
    );
    if (latest) {
      const ref = `ghcr.io/${owner.toLowerCase()}/${packageName.toLowerCase()}:${latest}`;
      this.logger.log(
        `skipBuild: app missing/no image — using GHCR latest tag for ${owner}/${packageName}: ${ref}`,
      );
      return ref;
    }

    throw new BadRequestException(
      `Cannot skip build: no image available. ` +
        `No prior build found for ${dto.repoFullName} on GHCR and no existing app with an imageRef. ` +
        `Options:\n` +
        `  • Run \`flui deploy\` (without --no-build) to perform a fresh build\n` +
        `  • Pass \`--image <ref>\` with an explicit image reference (e.g. ghcr.io/${owner}/${repoName}:abc1234)\n` +
        `If the build does exist on GHCR but isn't visible, you likely don't have a ` +
        `GHCR PAT configured (GitHub App / OAuth tokens cannot read container packages). ` +
        `Save one via POST /repositories/github-app/packages-pat or the dashboard.`,
    );
  }

  private async assertGitHubConnected(userId: string): Promise<void> {
    if (await this.githubAppService.isEnabled()) {
      const installations = await this.githubAppService.listInstallations();
      if (installations.length === 0) {
        throw new BadRequestException(
          'GitHub integration is not connected. ' +
            'Connect your GitHub account from the Flui dashboard under Settings → Integrations, ' +
            'then re-run `flui deploy`.',
        );
      }
      return;
    }

    const result = await this.githubOAuthService.testConnection(userId);
    if (!result.success) {
      throw new BadRequestException(
        'GitHub integration is not connected. ' +
          'Connect your GitHub account from the Flui dashboard under Settings → Integrations, ' +
          'then re-run `flui deploy`.',
      );
    }
  }

  private async assertGhcrPatPresent(userId: string): Promise<void> {
    const status = await this.githubAppUserAuthService.getGhcrPatStatus(userId);
    if (status.configured && status.status !== 'EXPIRED') return;
    throw new BadRequestException(
      status.configured ? 'GHCR PAT is expired' : 'GHCR PAT is not configured',
    );
  }

  /**
   * Ensure a public AppEndpoint exists for the application based on the
   * `flui.endpoint.spec` previously stored in `app.metadata` by `deployFromYaml`.
   *
   * Idempotent: if an endpoint already exists for the app, just (re)triggers
   * reconciliation. Safe to call from the deploy processor's finalize step,
   * after the K8s Service is ready.
   *
   * Failures are non-fatal: warnings are logged and the deploy is not failed.
   */
  async ensurePublicEndpoint(applicationId: string): Promise<void> {
    const app = await this.applicationsRepository.findById(applicationId);
    if (!app) return;
    if (app.exposure !== ApplicationExposure.PUBLIC) return;

    const specRaw = app.metadata?.[ENDPOINT_SPEC_METADATA_KEY];
    if (!specRaw) return;

    let spec: {
      auto?: boolean;
      tls?: boolean;
      fqdn?: string;
      hostnameMode?: 'ip' | 'domain';
      certChallenge?: 'http-01' | 'dns-01';
      certificateProvider?: 'lets-encrypt' | 'lets-encrypt-staging';
    };
    try {
      spec = JSON.parse(specRaw);
    } catch {
      this.logger.warn(
        `ensurePublicEndpoint(${applicationId}): invalid endpoint spec JSON in metadata, skipping`,
      );
      return;
    }

    if (spec.auto === false) return;

    const existing =
      await this.appEndpointService.listByApplicationId(applicationId);
    if (existing.length > 0) {
      // Endpoint already created — just retrigger reconciliation
      for (const ep of existing) {
        this.appEndpointReconciliationService
          .reconcile(ep.id)
          .catch((err) =>
            this.logger.warn(
              `ensurePublicEndpoint(${applicationId}): reconcile of existing endpoint ${ep.id} failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }
      return;
    }

    const assignment = spec.fqdn
      ? await this.clusterDnsZoneService.getZoneForFqdn(
          app.clusterId,
          spec.fqdn,
        )
      : await this.clusterDnsZoneService.getZoneAssignment(app.clusterId);
    const wildcardIssuer = assignment?.dnsZone?.zoneName
      ? await this.clusterDnsZoneService.resolveWildcardIssuer(app.clusterId)
      : null;

    let hostnameMode: HostnameMode | undefined;
    if (spec.hostnameMode === 'ip') hostnameMode = HostnameMode.IP;
    else if (spec.hostnameMode === 'domain') hostnameMode = HostnameMode.DOMAIN;

    let certChallenge: CertChallenge | undefined;
    if (spec.certChallenge === 'http-01') certChallenge = CertChallenge.HTTP_01;
    else if (spec.certChallenge === 'dns-01')
      certChallenge = CertChallenge.DNS_01;

    let certificateProvider: CertificateProvider | undefined;
    if (spec.certificateProvider === 'lets-encrypt') {
      certificateProvider = CertificateProvider.LETS_ENCRYPT;
    } else if (spec.certificateProvider === 'lets-encrypt-staging') {
      certificateProvider = CertificateProvider.LETS_ENCRYPT_STAGING;
    } else {
      certificateProvider = wildcardIssuer?.certificateProvider;
    }

    try {
      const endpoint = await this.appEndpointService.createEndpoint(
        app.clusterId,
        {
          applicationId,
          clusterDnsZoneId: assignment?.id,
          certificateRequired: spec.tls !== false,
          ...(spec.fqdn ? { fqdn: spec.fqdn } : {}),
          ...(hostnameMode ? { hostnameMode } : {}),
          ...(certChallenge ? { certChallenge } : {}),
          ...(certificateProvider ? { certificateProvider } : {}),
        },
      );
      this.logger.log(
        `ensurePublicEndpoint(${applicationId}): endpoint created fqdn=${endpoint.fqdn} mode=${endpoint.hostnameMode}/${endpoint.certChallenge} tls=${spec.tls !== false}`,
      );

      this.appEndpointReconciliationService
        .reconcile(endpoint.id)
        .catch((err) =>
          this.logger.warn(
            `ensurePublicEndpoint(${applicationId}): reconcile failed for ${endpoint.id}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    } catch (err) {
      this.logger.warn(
        `ensurePublicEndpoint(${applicationId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
