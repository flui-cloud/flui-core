import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
  HttpException,
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
import {
  validateApplicationManifest,
  parseApplicationManifest,
  serializeApplicationManifest,
} from '../utils/application-manifest.util';
import {
  applyDeployOverrides,
  collectOverrideShadows,
  DeployOverrides,
  DEPLOY_OVERRIDES_METADATA_KEY,
  hasDeployOverrides,
  mergeDeployOverrides,
  readStoredOverrides,
} from '../utils/deploy-overrides.util';
import { ApplicationManifestEnvVar } from '@flui-cloud/spec';
import {
  ApplicationEnvVar,
  GitBuildSourceConfig,
} from '../interfaces/source-config.interface';
import { RepositoriesService } from '../../repositories/services/repositories.service';
import { mergeAppEnv, collectEnvShadows } from '../utils/env-merge.util';
import { materializeDeclaredSecrets } from '../utils/env-write.util';
import {
  applyEnvironmentProfile,
  manifestDeclaredEnvNames,
  normalizeManifestEnv,
  pickAppManifest,
  readServiceRef,
  resolveServiceRefAgainst,
  ServiceRef,
  ServiceRefScope,
} from '../utils/manifest-env.util';
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
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import {
  ClusterStatus,
  ClusterType,
  normalizeClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import {
  checksFor,
  wouldDeploy,
  type CapacityFact,
  type ManifestCheck,
} from '../manifest-checks.core';
import { HostnameMode } from '../../dns/enums/hostname-mode.enum';
import { CertChallenge } from '../../dns/enums/cert-challenge.enum';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';

const ENDPOINT_SPEC_METADATA_KEY = 'flui.endpoint.spec';

const SERVICE_REF_SKIP_REASON = {
  'not-found': 'matches no app',
  'cross-cluster': 'is on another cluster — not reachable in-cluster',
  'cross-project': 'belongs to a different project',
} as const;

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
    private readonly repositoriesService: RepositoriesService,
    @Inject(forwardRef(() => ApplicationDeployService))
    private readonly applicationDeployService: ApplicationDeployService,
    @Inject(forwardRef(() => AppEndpointService))
    private readonly appEndpointService: AppEndpointService,
    @Inject(forwardRef(() => AppEndpointReconciliationService))
    private readonly appEndpointReconciliationService: AppEndpointReconciliationService,
    @Inject(forwardRef(() => ClusterDnsZoneService))
    private readonly clusterDnsZoneService: ClusterDnsZoneService,
    @Inject(forwardRef(() => ClustersService))
    private readonly clustersService: ClustersService,
  ) {}

  /**
   * `userEmail` is required, not optional: it is what places the application in
   * the caller's namespace. Until it was threaded through, this path called
   * `create()` with three arguments and every manifest deploy landed in
   * `default` — outside the caller's quota, network policy and expiry sweep.
   * Keeping it non-optional is what stops that from silently returning.
   */
  async deployFromYaml(
    userId: string,
    dto: DeployFromYamlDto,
    userEmail: string,
  ): Promise<DeployFromYamlResponseDto> {
    let manifest = this.parseAndValidate(dto.yaml);

    if (dto.validateOnly) {
      return this.buildValidationPreview(userId, manifest, dto);
    }

    await this.assertGitHubConnected(userId);
    await this.assertGhcrPatPresent(userId);

    const branch = dto.branch ?? 'main';
    // Overlay the environment bound to this branch (staging/prod), if any.
    manifest = applyEnvironmentProfile(manifest, branch);
    // The release name is identity-forming, so it must be applied before the
    // app lookup — the rest of the overrides are merged with the ones stored
    // on the app we find.
    if (dto.overrides?.name) {
      manifest = applyDeployOverrides(manifest, { name: dto.overrides.name });
    }
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

    const effectiveOverrides = this.resolveInstallOverrides(
      manifest,
      app?.metadata,
      dto.overrides,
    );
    manifest = applyDeployOverrides(manifest, effectiveOverrides);

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

    const manifestEnv = await this.buildManifestEnv(manifest, {
      clusterId: dto.clusterId,
      projectId: app?.projectId ?? null,
    });
    const resources = this.resolveResources(manifest);
    const healthProbe = this.resolveHealthProbe(manifest);

    const sourceConfig = {
      type: 'git_build' as const,
      repositoryId: repository.id,
      branch,
      gitUrl: repository.cloneUrl,
      dockerfile: buildPaths.dockerfile,
      context: buildPaths.context,
      ...(buildPaths.subPath ? { subPath: buildPaths.subPath } : {}),
    };

    const manifestMetadata = this.buildManifestMetadata(
      manifest,
      effectiveOverrides,
    );

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
          env: materializeDeclaredSecrets(
            mergeAppEnv([], manifestEnv, dto.envOverrides),
            normalizeManifestEnv(manifest.deploy.env),
          ),
          resources,
          healthProbe: healthProbe as any,
          startCommand: manifest.deploy.startCommand,
          volumes: (manifest.deploy.volumes as any) ?? [],
          autoDeploy: false,
          metadata: manifestMetadata,
        },
        userId,
        userEmail,
      );
    } else {
      this.logger.log(`Updating existing application from manifest: ${app.id}`);

      const updatedMetadata = { ...app.metadata, ...manifestMetadata };

      const existingEnv = (app.env as ApplicationEnvVar[]) ?? [];
      this.warnEnvShadows(existingEnv, manifestEnv, dto.envOverrides);

      await this.applicationsRepository.update(app.id, {
        sourceConfig: sourceConfig as any,
        port: manifest.deploy.port,
        exposure:
          (manifest.deploy.exposure as ApplicationExposure) ?? app.exposure,
        env: materializeDeclaredSecrets(
          mergeAppEnv(
            existingEnv,
            manifestEnv,
            dto.envOverrides,
            manifestDeclaredEnvNames(manifest.deploy.env),
          ),
          normalizeManifestEnv(manifest.deploy.env),
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

  /**
   * The manifest-derived slice of `app.metadata`: the endpoint spec consumed by
   * `ensurePublicEndpoint`, and the install overrides that must outlive this
   * deploy. Returns undefined when the manifest carries neither, so an app
   * without them keeps a clean metadata object.
   */
  private buildManifestMetadata(
    manifest: ApplicationManifest,
    overrides: DeployOverrides,
  ): Record<string, any> | undefined {
    const metadata: Record<string, any> = {};
    if (manifest.deploy.domain) {
      metadata[ENDPOINT_SPEC_METADATA_KEY] = JSON.stringify(
        manifest.deploy.domain,
      );
    }
    if (hasDeployOverrides(overrides)) {
      metadata[DEPLOY_OVERRIDES_METADATA_KEY] = overrides;
    }
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  /**
   * Dry run: the manifest as it would be applied, with the branch environment
   * and the install-time overrides baked in. Lets every surface show (and let
   * the user download) what a deploy would actually produce.
   */
  /**
   * A deploy that stops before it acts.
   *
   * It runs the same parse and the same overlay the real path runs — that is why
   * it lives here rather than in a validator of its own — and then asks this
   * installation the questions a schema cannot answer. An author gets the
   * effective manifest *and* the reasons it would or would not land, without
   * having pushed anything.
   */
  private async buildValidationPreview(
    userId: string,
    manifest: ApplicationManifest,
    dto: DeployFromYamlDto,
  ): Promise<DeployFromYamlResponseDto> {
    const preview = applyDeployOverrides(
      applyEnvironmentProfile(manifest, dto.branch ?? 'main'),
      dto.overrides,
    );
    const checks = await this.installationChecks(userId, preview, dto);
    return {
      applicationId: '',
      slug: '',
      name: preview.metadata.name,
      status: 'valid',
      effectiveYaml: serializeApplicationManifest(preview),
      checks,
      wouldDeploy: wouldDeploy(checks),
    };
  }

  /**
   * Every fact is gathered on its own and a failure to read one is `null`, never
   * a false. An installation that cannot be reached has refused nothing, and a
   * check that reported otherwise would send an author rewriting a manifest that
   * was correct all along.
   */
  private async installationChecks(
    userId: string,
    manifest: ApplicationManifest,
    dto: DeployFromYamlDto,
  ): Promise<ManifestCheck[]> {
    const branch = dto.branch ?? 'main';
    const cluster = await this.readCluster(dto.clusterId);
    const repository = dto.repoFullName
      ? await this.repositoriesRepository
          .findByUserIdAndFullName(userId, dto.repoFullName)
          .catch(() => null)
      : null;

    const [githubConnected, registryCredential] = await Promise.all([
      this.canRead(() => this.assertGitHubConnected(userId)),
      this.canRead(() => this.assertGhcrPatPresent(userId)),
    ]);

    const existingApp =
      repository && cluster.found
        ? await this.findExistingApp(
            dto.clusterId,
            repository.id,
            branch,
            manifest.metadata.name,
          ).catch(() => null)
        : null;

    const zone = await this.clusterDnsZoneService
      .getZoneAssignment(dto.clusterId)
      .catch(() => null);

    return checksFor({
      clusterFound: cluster.found,
      clusterReady: cluster.ready,
      clusterName: cluster.name,
      repositoryConnected: dto.repoFullName ? !!repository : null,
      repoFullName: dto.repoFullName ?? null,
      githubConnected,
      registryCredential,
      existingApp: existingApp?.slug ?? null,
      capacity: await this.readCapacity(dto.clusterId, manifest),
      exposure:
        manifest.deploy?.exposure === 'internal' ? 'internal' : 'public',
      dnsZone: zoneName(zone),
      fqdn: manifest.deploy?.domain?.fqdn ?? null,
      targetIsControlCluster: cluster.isControl,
      hasWorkloadCluster: cluster.isControl
        ? await this.hasWorkloadCluster()
        : null,
    });
  }

  private async readCluster(clusterId: string): Promise<{
    found: boolean;
    ready: boolean | null;
    name: string | null;
    isControl: boolean;
  }> {
    try {
      const cluster = await this.clustersService.getClusterEntity(clusterId);
      return {
        found: true,
        ready: cluster.status === ClusterStatus.READY,
        name: cluster.name,
        isControl:
          normalizeClusterType(cluster.clusterType) === ClusterType.CONTROL,
      };
    } catch (error) {
      // A missing cluster is an answer; anything else is a failure to look.
      if (error instanceof NotFoundException) {
        return { found: false, ready: null, name: null, isControl: false };
      }
      return { found: true, ready: null, name: null, isControl: false };
    }
  }

  /**
   * Null when the installation could not be listed. It only softens the wording
   * of a warning, so guessing would cost nothing and mean nothing.
   */
  private async hasWorkloadCluster(): Promise<boolean | null> {
    try {
      const clusters = await this.clustersService.listClusters();
      return clusters.some(
        (c) => normalizeClusterType(c.clusterType) === ClusterType.WORKLOAD,
      );
    } catch {
      return null;
    }
  }

  /**
   * Weighed only against what the manifest actually declares. A manifest with no
   * requests is not weightless — the cluster applies its own default — so
   * inventing a figure here would answer a question nobody asked.
   */
  private async readCapacity(
    clusterId: string,
    manifest: ApplicationManifest,
  ): Promise<CapacityFact | null> {
    const requests = manifest.deploy?.resources?.requests;
    const cpuMc = cpuToMillicores(requests?.cpu);
    const memMi = memoryToMi(requests?.memory);
    if (cpuMc === null || memMi === null) return null;

    // The floor of the scaling range is what the deploy starts with; a manifest
    // that declares none runs a single replica.
    const replicas = manifest.deploy?.scaling?.min ?? 1;
    try {
      const availability = await this.clustersService.checkResourceAvailability(
        clusterId,
        cpuMc,
        memMi,
        replicas,
      );
      return {
        fits: availability.canDeploy,
        requiredCpuMc: cpuMc * replicas,
        requiredMemoryMi: memMi * replicas,
        availableCpuMc: cpuToMillicores(availability.available?.cpu),
        availableMemoryMi: memoryToMi(availability.available?.memory),
      };
    } catch {
      return null;
    }
  }

  /** True, false, or null when the question itself could not be put. */
  private async canRead(
    probe: () => Promise<unknown>,
  ): Promise<boolean | null> {
    try {
      await probe();
      return true;
    } catch (error) {
      return error instanceof HttpException ? false : null;
    }
  }

  /**
   * The overrides this deploy runs with: what was stored on the app, updated by
   * what the caller passed (see deploy-overrides.util for the precedence rules).
   * Every manifest value they mask is logged, so the operator can see why the
   * repo says one thing and the cluster does another.
   */
  private resolveInstallOverrides(
    manifest: ApplicationManifest,
    storedMetadata: Record<string, any> | null | undefined,
    incoming?: DeployOverrides,
  ): DeployOverrides {
    const effective = mergeDeployOverrides(
      readStoredOverrides(storedMetadata),
      incoming,
    );
    for (const shadow of collectOverrideShadows(manifest, effective)) {
      this.logger.warn(
        `[${manifest.metadata.name}] install override shadows the manifest: ${shadow}`,
      );
    }
    return effective;
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

  private resolveHealthProbe(manifest: ApplicationManifest) {
    return manifest.deploy.healthcheck
      ? {
          type: 'http' as const,
          httpPath: manifest.deploy.healthcheck.path,
          httpPort: manifest.deploy.healthcheck.port ?? manifest.deploy.port,
          httpScheme: 'HTTP' as const,
        }
      : { type: 'none' as const };
  }

  /**
   * Re-read the app's flui.yaml at a pushed commit and apply its runtime config
   * (env, port, exposure, resources, healthcheck, domain) to the existing app,
   * so a `git push` is git-authoritative like `flui deploy` — not an image swap
   * over stale DB env. Build configuration is left untouched: the image the
   * caller is about to deploy was already built from this commit.
   *
   * Best-effort: a missing, renamed or invalid manifest is logged and skipped,
   * never blocking the deploy. Writes only the DB row; the caller triggers the
   * single rollout that carries the refreshed env (writing env alone starts no
   * rollout — the reconciler keys off the last deploy's manifest hash).
   */
  async reapplyManifestAtCommit(
    appId: string,
    commitSha: string,
    branch?: string,
  ): Promise<void> {
    const app = await this.applicationsRepository.findById(appId);
    if (app?.sourceType !== ApplicationSourceType.GIT_BUILD) return;

    const sourceConfig = app.sourceConfig as GitBuildSourceConfig;
    if (!sourceConfig?.repositoryId) return;
    const repository = await this.repositoriesRepository.findById(
      sourceConfig.repositoryId,
    );
    const [owner, repoName] = (repository?.repositoryFullName ?? '').split('/');
    if (!owner || !repoName) return;

    const short = commitSha.slice(0, 7);
    let manifest: ApplicationManifest | null = null;
    try {
      const { manifests } = await this.repositoriesService.getFluiManifests(
        app.userId,
        owner,
        repoName,
        commitSha,
      );
      const chosen = pickAppManifest(manifests, app.name, sourceConfig.subPath);
      if (chosen?.content) {
        manifest = applyEnvironmentProfile(
          parseApplicationManifest(chosen.content),
          branch,
        );
      }
    } catch (error) {
      this.logger.warn(
        `reapply flui.yaml ${app.slug}@${short}: ${error.message} — deploying with existing env.`,
      );
      return;
    }
    if (!manifest) {
      this.logger.warn(
        `reapply flui.yaml ${app.slug}@${short}: no matching manifest at this commit — deploying with existing env.`,
      );
      return;
    }

    const manifestEnv = await this.buildManifestEnv(manifest, {
      clusterId: app.clusterId,
      projectId: app.projectId ?? null,
    });
    const existingEnv = (app.env as ApplicationEnvVar[]) ?? [];
    this.warnEnvShadows(existingEnv, manifestEnv);

    const endpointSpecJson = manifest.deploy.domain
      ? JSON.stringify(manifest.deploy.domain)
      : undefined;

    await this.applicationsRepository.update(app.id, {
      port: manifest.deploy.port,
      exposure:
        (manifest.deploy.exposure as ApplicationExposure) ?? app.exposure,
      env: materializeDeclaredSecrets(
        mergeAppEnv(
          existingEnv,
          manifestEnv,
          undefined,
          manifestDeclaredEnvNames(manifest.deploy.env),
        ),
        normalizeManifestEnv(manifest.deploy.env),
      ),
      resources: this.resolveResources(manifest),
      healthProbe: this.resolveHealthProbe(manifest) as any,
      startCommand: manifest.deploy.startCommand ?? null,
      metadata: endpointSpecJson
        ? { ...app.metadata, [ENDPOINT_SPEC_METADATA_KEY]: endpointSpecJson }
        : app.metadata,
    });
    this.logger.log(
      `Re-applied flui.yaml for ${app.slug} at ${short} — git is authoritative on this deploy.`,
    );
  }

  /** Env declared by the flui.yaml, tagged `manifest` so a deploy only owns these keys. */
  private warnEnvShadows(
    existing: ApplicationEnvVar[],
    manifestEnv: ApplicationEnvVar[],
    overrides?: Record<string, string>,
  ): void {
    for (const s of collectEnvShadows(existing, manifestEnv, overrides)) {
      this.logger.warn(
        `env "${s.name}": manifest reclaims key — overwriting pinned value ` +
          `"${s.previous}" (dashboard/--env) with "${s.manifest}" from flui.yaml. ` +
          `Pass --env ${s.name}=… to keep a different value.`,
      );
    }
  }

  private async buildManifestEnv(
    manifest: ApplicationManifest,
    scope: ServiceRefScope,
  ): Promise<ApplicationEnvVar[]> {
    const out: ApplicationEnvVar[] = [];
    for (const e of normalizeManifestEnv(manifest.deploy.env)) {
      const ref = readServiceRef(e);
      const resolved = ref
        ? await this.resolveServiceRef(e.name, ref, scope)
        : this.manifestEnvVar(e);
      if (resolved) out.push(resolved);
    }
    return out;
  }

  /**
   * Resolve a `valueFrom.service` reference to the sibling app's in-cluster
   * address. The reference is matched by slug within the same cluster (and,
   * when both apps are assigned to one, the same project). Missing, cross-
   * cluster or cross-project targets are skipped with a warning rather than
   * failing the deploy — the var is simply absent, as it was before 0.8.0.
   */
  private async resolveServiceRef(
    name: string,
    ref: ServiceRef,
    scope: ServiceRefScope,
  ): Promise<ApplicationEnvVar | null> {
    const app = await this.applicationsRepository.findBySlug(ref.service);
    const sibling = app
      ? {
          slug: app.slug,
          namespace: app.k8sNamespace,
          port: app.port,
          clusterId: app.clusterId,
          projectId: app.projectId,
          deleted: !!app.deletedAt,
        }
      : null;

    const { value, reason } = resolveServiceRefAgainst(ref, scope, sibling);
    if (reason) {
      this.logger.warn(
        `env "${name}": valueFrom.service "${ref.service}" ${SERVICE_REF_SKIP_REASON[reason]}; skipped.`,
      );
      return null;
    }
    return { name, value, source: 'manifest' };
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
      const installations =
        await this.githubAppService.listReachableInstallations(userId);
      if (installations.length === 0) {
        throw new BadRequestException(
          'GitHub integration is not connected. ' +
            'Connect your GitHub account from the Flui dashboard under Settings → Integrations, ' +
            'then re-run `flui deploy`.',
        );
      }
      return;
    }

    // PAT mode has no per-user OAuth session, so a live OAuth test always fails
    // here even when the PAT is configured and healthy. Gate on the stored
    // connection instead — the same signal `integration status` reports.
    const status = await this.githubOAuthService.getStatus(userId);
    if (!status.connected) {
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

/**
 * Kubernetes quantities as the manifest already writes them. Unparseable is
 * null rather than a default: a figure nobody wrote is not a figure to weigh a
 * cluster against.
 */
function cpuToMillicores(value?: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw.endsWith('m')) {
    const n = Number.parseFloat(raw.slice(0, -1));
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  const cores = Number.parseFloat(raw);
  return Number.isFinite(cores) ? Math.round(cores * 1000) : null;
}

const MEMORY_UNITS: Record<string, number> = {
  Ki: 1 / 1024,
  Mi: 1,
  Gi: 1024,
  Ti: 1024 * 1024,
};

function memoryToMi(value?: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  const match = raw.match(/^([0-9.]+)\s*(Ki|Mi|Gi|Ti)?$/);
  if (!match) return null;
  const n = Number.parseFloat(match[1]);
  if (!Number.isFinite(n)) return null;
  // No suffix is bytes, which is what Kubernetes means by a bare number.
  const factor = match[2] ? MEMORY_UNITS[match[2]] : 1 / (1024 * 1024);
  return Math.round(n * factor);
}

/** The assignment shape varies by caller; only its zone name is needed here. */
function zoneName(zone: unknown): string | null {
  if (!zone || typeof zone !== 'object') return null;
  const named = zone as { zoneName?: string; name?: string; zone?: string };
  return named.zoneName ?? named.name ?? named.zone ?? null;
}
