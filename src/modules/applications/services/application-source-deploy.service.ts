import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Inject,
  Optional,
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
import {
  mergeAppEnv,
  mergeLinkEnv,
  collectEnvShadows,
} from '../utils/env-merge.util';
import {
  ATTACHED_SERVICES_PORT,
  AttachedServiceRecord,
  AttachedServiceSpec,
  AttachedServicesPort,
} from '../interfaces/attached-services.port';
import { materializeDeclaredSecrets } from '../utils/env-write.util';
import {
  applyEnvironmentProfile,
  manifestDeclaredEnvNames,
  normalizeManifestEnv,
  pickAppManifest,
  readServiceRef,
  resolveServiceRefAgainst,
  seedUserInputDefaults,
  ServiceRef,
  ServiceRefScope,
} from '../utils/manifest-env.util';
import { generateRandomSecret } from '../../../common/utils/random-secret.util';
import {
  DeployFromYamlDto,
  DeployFromYamlResponseDto,
} from '../dto/deploy-from-yaml.dto';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import { ApplicationCategory } from '../enums/application-category.enum';
import { ApplicationExposure } from '../enums/application-exposure.enum';
import { AppEndpointService } from '../../dns/services/app-endpoint.service';
import { AppEndpointEntity } from '../../dns/entities/app-endpoint.entity';
import { AppEndpointReconciliationService } from '../../dns/services/app-endpoint-reconciliation.service';
import { ClusterDnsZoneService } from '../../dns/services/cluster-dns-zone.service';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import {
  ClusterStatus,
  ClusterType,
  normalizeClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import {
  wouldDeploy,
  type CapacityFact,
  type ManifestCheck,
} from '../manifest-checks.core';
import { allChecksFor, type RepoFacts } from '../manifest-repo-checks.core';
import { manifestSelfFacts } from '../manifest-self-facts.core';
import { RepoFactsReaderService } from './repo-facts-reader.service';
import { EndpointType } from '../../dns/enums/endpoint-type.enum';
import { HostnameMode } from '../../dns/enums/hostname-mode.enum';
import { CertChallenge } from '../../dns/enums/cert-challenge.enum';
import { CertificateProvider } from '../../providers/enums/certificate-provider.enum';
import { ApplicationEntity } from '../entities/application.entity';
import {
  readEndpointFailure,
  withEndpointFailure,
  withoutEndpointFailure,
} from '../utils/endpoint-failure.util';
import { EndpointDiagnosisService } from '../../scaling/services/endpoint-diagnosis.service';

const ENDPOINT_SPEC_METADATA_KEY = 'flui.endpoint.spec';

/** `deploy.domain` as the manifest wrote it: every field an override, none of them the trigger. */
interface EndpointSpec {
  auto?: boolean;
  tls?: boolean;
  fqdn?: string;
  hostnameMode?: 'ip' | 'domain';
  certChallenge?: 'http-01' | 'dns-01';
  certificateProvider?: 'lets-encrypt' | 'lets-encrypt-staging';
}

/**
 * A manifest deploy stopped one step before it writes to GitHub: the
 * Application exists, its services are up, and nothing has been committed.
 */
export interface PreparedApplicationFromYaml {
  app: ApplicationEntity;
  /** The manifest as applied — branch environment and overrides baked in. */
  manifest: ApplicationManifest;
  branch: string;
  repositoryId: string;
  buildPaths: { dockerfile: string; context: string; subPath?: string };
  skipBuild: boolean;
  /** The image to deploy when `skipBuild` — null when a build is expected. */
  resolvedImageRef: string | null;
  /**
   * The services this preparation brought up, `name=block`. Reported because
   * preparing is the step that provisions databases: a caller that fails
   * afterwards has to be able to say what already exists rather than leave a
   * person to find a Postgres nobody named.
   */
  attachedServices: string[];
  /** True when an application left behind by an earlier attempt was reused. */
  adopted: boolean;
}

/**
 * A caller that owns more of the sequence than this service does — the apply,
 * which prepares N applications before it writes anything to GitHub.
 */
export interface PrepareOptions {
  /**
   * Reuse this application row instead of looking one up by identity.
   *
   * The apply cuts a branch per base commit, so an attempt abandoned on
   * `flui/deploy-<A7>` cannot be found again from `flui/deploy-<B7>`: the
   * branch is part of the identity. The caller that knows those two attempts
   * are the same intent passes the row here, and the alternative it avoids is
   * a second application — with a second database — beside the first.
   *
   * Ignored, with a log line, when the row is gone or sits on another cluster:
   * a deleted orphan means a person already dealt with it.
   */
  adoptApplicationId?: string;
}

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
    private readonly repoFactsReader: RepoFactsReaderService,
    @Inject(forwardRef(() => EndpointDiagnosisService))
    private readonly endpointDiagnosisService: EndpointDiagnosisService,
    // Provisioning a catalog block from here would mean importing the module
    // that already imports this one, so the implementation is injected through
    // a token from a module above both. Optional: a build without it still
    // deploys applications that attach nothing, and refuses — loudly — the ones
    // that do (see `assertAttachable`).
    @Optional()
    @Inject(ATTACHED_SERVICES_PORT)
    private readonly attachedServices?: AttachedServicesPort,
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
    if (dto.validateOnly) {
      return this.buildValidationPreview(
        userId,
        this.parseAndValidate(dto.yaml),
        dto,
      );
    }

    const prepared = await this.prepareApplicationFromYaml(
      userId,
      dto,
      userEmail,
    );
    const { app, manifest, branch, buildPaths, skipBuild, resolvedImageRef } =
      prepared;

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
          buildArgs: manifest.build?.args,
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
   * Everything a manifest deploy does *before* it writes to GitHub: validate,
   * resolve the repository and the build paths, find or create the
   * Application, merge its environment, and bring up the services the manifest
   * attaches.
   *
   * Split out because the apply path needs exactly this and not the tail: it
   * creates N applications on one branch and then lands one atomic commit for
   * all of them, whereas `deployFromYaml`'s tail commits one workflow per call.
   * Nothing here touches the repository, so a caller that fails afterwards has
   * left rows in the database and nothing in anyone's git history — rows that
   * may already own a running database, which is why the result names the
   * services it brought up and why `opts.adoptApplicationId` exists.
   */
  async prepareApplicationFromYaml(
    userId: string,
    dto: DeployFromYamlDto,
    userEmail: string,
    opts?: PrepareOptions,
  ): Promise<PreparedApplicationFromYaml> {
    let manifest = this.parseAndValidate(dto.yaml);

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

    const adopted = opts?.adoptApplicationId
      ? await this.resolveAdoptedApp(opts.adoptApplicationId, dto.clusterId)
      : null;
    let app =
      adopted ??
      (await this.findExistingApp(
        dto.clusterId,
        repository.id,
        branch,
        manifest.metadata.name,
      ));

    const effectiveOverrides = this.resolveInstallOverrides(
      manifest,
      app?.metadata,
      dto.overrides,
    );
    manifest = applyDeployOverrides(manifest, effectiveOverrides);

    // Before anything is created: a `deploy.services` we cannot honour must be
    // a refusal here, not an application that comes up green without its
    // database. Same call the `--validate-only` preview makes.
    await this.validateAttachedServices(manifest);

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

    const existingEnv = this.seedAndWarnUserInputs(
      manifest,
      (app?.env as ApplicationEnvVar[]) ?? [],
    );
    const manifestEnv = await this.buildManifestEnv(
      manifest,
      { clusterId: dto.clusterId, projectId: app?.projectId ?? null },
      existingEnv,
    );
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
            mergeAppEnv(
              existingEnv,
              manifestEnv,
              dto.envOverrides,
              undefined,
              dto.secretEnvKeys,
            ),
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
            dto.secretEnvKeys,
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

    // The services the manifest attaches are brought up and wired in BEFORE any
    // build or deploy is started: the deploy renders `app.env`, so an
    // attachment that landed afterwards would ship one rollout too late — the
    // application would run once without its own database.
    const reconciled = await this.reconcileAttachedServices(app, manifest, {
      userId,
      userEmail,
      clusterId: dto.clusterId,
    });
    app = reconciled.app;

    return {
      app,
      manifest,
      branch,
      repositoryId: repository.id,
      buildPaths,
      skipBuild,
      resolvedImageRef,
      attachedServices: reconciled.attachments.map(
        (a) => `${a.name}=${a.block}`,
      ),
      adopted: adopted !== null,
    };
  }

  /**
   * The row a caller asked to reuse, when reusing it is defensible.
   *
   * Two refusals, both of which fall back to the ordinary lookup rather than
   * failing: the row is gone (a person removed the orphan, which is exactly
   * the outcome the removal preview exists to produce), or it belongs to
   * another cluster (an identity this deploy has no claim on). Neither is an
   * error — but neither is silent, because a reuse that did not happen changes
   * what the next screen shows.
   */
  private async resolveAdoptedApp(
    applicationId: string,
    clusterId: string,
  ): Promise<ApplicationEntity | null> {
    const app = await this.applicationsRepository.findById(applicationId);
    if (!app) {
      this.logger.warn(
        `Asked to reuse application ${applicationId}, which no longer exists — creating a new one instead.`,
      );
      return null;
    }
    if (app.clusterId !== clusterId) {
      this.logger.warn(
        `Asked to reuse application ${applicationId}, which is on cluster ${app.clusterId} and not ${clusterId} — creating a new one instead.`,
      );
      return null;
    }
    this.logger.log(
      `Reusing application ${app.slug} (${app.id}) left behind by an earlier attempt.`,
    );
    return app;
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
    await this.validateAttachedServices(preview);
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

    const repo = await this.repoFacts(userId, dto, branch, !!repository);

    return allChecksFor(
      {
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
      },
      manifestSelfFacts(manifest),
      repo,
    );
  }

  /**
   * The repository, read at the ref being validated, or nothing.
   *
   * `undefined` — not `read: false` — when no repository was named: the answer
   * is then byte-identical to what this endpoint has always returned, plus the
   * currency note, which needs no repository. A repository named but not
   * connected is decided here rather than by attempting a read, because that
   * is the fact we hold and no GitHub call can improve on it.
   */
  private async repoFacts(
    userId: string,
    dto: DeployFromYamlDto,
    branch: string,
    connected: boolean,
  ): Promise<RepoFacts | undefined> {
    const fullName = dto.repoFullName;
    if (!fullName) return undefined;
    if (!connected) {
      return {
        read: false,
        reason: 'not-connected',
        repoFullName: fullName,
        ref: branch,
      };
    }
    const [owner, repo] = fullName.split('/');
    if (!owner || !repo) {
      return {
        read: false,
        reason: 'not-found',
        repoFullName: fullName,
        ref: branch,
      };
    }
    return this.repoFactsReader.factsFor(userId, { owner, repo, ref: branch });
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

    const existingEnv = this.seedAndWarnUserInputs(
      manifest,
      (app.env as ApplicationEnvVar[]) ?? [],
    );
    const manifestEnv = await this.buildManifestEnv(
      manifest,
      { clusterId: app.clusterId, projectId: app.projectId ?? null },
      existingEnv,
    );
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
    // A push that ADDS a service must create it, and a push that changes its
    // wiring must rewire it. Without this the git-authoritative path re-reads
    // `deploy.env` only, and a service added in a commit would never exist.
    const refreshed = await this.applicationsRepository.findById(app.id);
    if (refreshed) {
      // The same refusals `flui deploy` makes must be made here. A name that collides with the
      // application's own `deploy.env`, or a service on a manifest with no port, was rejected on
      // the interactive path and merged silently on the push path — and a silent merge means the
      // value someone can still read in git is not the value that runs.
      await this.validateAttachedServices(manifest);
      await this.reconcileAttachedServices(refreshed, manifest, {
        userId: app.userId,
        // No person is on the other end of a push; the owner's address is read
        // from the application itself where a namespace depends on it.
        clusterId: app.clusterId,
      });
    }

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

  // ─── Attached services (`deploy.services`) ─────────────────────────────────

  /** What the manifest attaches, in the shape the port speaks. */
  private declaredServices(
    manifest: ApplicationManifest,
  ): AttachedServiceSpec[] {
    const services = (manifest.deploy as { services?: AttachedServiceSpec[] })
      .services;
    return services ?? [];
  }

  /**
   * Refuse a manifest whose attached services cannot be honoured — before an
   * application row exists.
   *
   * Two refusals, and both matter more than they look:
   *   - no implementation of the port at all. A manifest that DECLARES services
   *     must never deploy without them: it would come up green, answer health
   *     checks, and have no database.
   *   - a name declared both by `deploy.env` and by a service's env. Whichever
   *     list merges second wins, silently, and the loser is a variable someone
   *     wrote down and can still read in git.
   */
  private async validateAttachedServices(
    manifest: ApplicationManifest,
  ): Promise<void> {
    const services = this.declaredServices(manifest);
    if (!services.length) return;

    if (!this.attachedServices) {
      throw new BadRequestException(
        'This manifest declares deploy.services, but this deployment of Flui ' +
          'cannot provision building blocks. Deploying it would start the ' +
          'application without them — remove the services or use a build that ' +
          'supports them.',
      );
    }

    const ownEnvNames = new Set(
      normalizeManifestEnv(manifest.deploy.env).map((e) => e.name),
    );
    const clashes = services
      .flatMap((svc) => (svc.env ?? []).map((e) => e.name))
      .filter((name) => ownEnvNames.has(name));
    if (clashes.length) {
      throw new BadRequestException(
        `deploy.env and deploy.services both declare ${[...new Set(clashes)].join(', ')}. ` +
          'One of the two would silently win — give the service env a different name.',
      );
    }

    await this.attachedServices.validate(services);
  }

  /**
   * Bring the attached services up and write the env that reaches them.
   *
   * Returns the application as it now stands, because the env it carries has
   * changed and every caller downstream renders from it — and the attachments
   * it brought up, because a caller that fails after this point has to be able
   * to name the databases that now exist.
   */
  private async reconcileAttachedServices(
    app: ApplicationEntity,
    manifest: ApplicationManifest,
    ctx: { userId: string; userEmail?: string; clusterId: string },
  ): Promise<{ app: ApplicationEntity; attachments: AttachedServiceRecord[] }> {
    const services = this.declaredServices(manifest);
    if (!services.length || !this.attachedServices)
      return { app, attachments: [] };

    const result = await this.attachedServices.reconcile({
      applicationId: app.id,
      clusterId: ctx.clusterId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      services,
    });

    const env = mergeLinkEnv(
      (app.env as ApplicationEnvVar[]) ?? [],
      result.env,
      result.ownedNames,
    );
    await this.applicationsRepository.update(app.id, { env });

    const attachmentsLabel = result.attachments
      .map((a) => `${a.name}=${a.block}`)
      .join(', ');
    this.logger.log(
      `${app.slug}: ${result.attachments.length} attached service(s) ready ` +
        `(${attachmentsLabel}), ` +
        `${result.env.length} env entries wired`,
    );

    return {
      app: (await this.applicationsRepository.findById(app.id)) ?? app,
      attachments: result.attachments,
    };
  }

  private async buildManifestEnv(
    manifest: ApplicationManifest,
    scope: ServiceRefScope,
    existingEnv: ApplicationEnvVar[] = [],
  ): Promise<ApplicationEnvVar[]> {
    const existingByName = new Map(existingEnv.map((e) => [e.name, e]));
    const out: ApplicationEnvVar[] = [];
    for (const e of normalizeManifestEnv(manifest.deploy.env)) {
      const ref = readServiceRef(e);
      const resolved = ref
        ? await this.resolveServiceRef(e.name, ref, scope)
        : this.manifestEnvVar(e, existingByName.get(e.name));
      if (resolved) out.push(resolved);
    }
    return out;
  }

  /**
   * `valueFrom.userInput` vars with no stored value yet: seed the manifest's
   * `default` (once, as a `user` entry — see `seedUserInputDefaults`) and warn
   * by name about the rest, so a var this incapable of resolving on its own
   * never reaches a container silently empty.
   */
  private seedAndWarnUserInputs(
    manifest: ApplicationManifest,
    existingEnv: ApplicationEnvVar[],
  ): ApplicationEnvVar[] {
    const { existing, missingRequired } = seedUserInputDefaults(
      normalizeManifestEnv(manifest.deploy.env),
      existingEnv,
    );
    for (const name of missingRequired) {
      this.logger.warn(
        `env "${name}": valueFrom.userInput has no default and no value has ` +
          `been set — deploying without it. Set one with PUT /variables/applications/:id ` +
          `(or --env ${name}=…) before this matters.`,
      );
    }
    return existing;
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
    existing?: ApplicationEnvVar,
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
    // `valueFrom.generate: secret` — created once, here, on the host; kept
    // stable across every later deploy (see `ApplicationEnvVar.generated`),
    // because a fresh draw on every redeploy would rotate a running app's own
    // JWT secret or DB password out from under it.
    if (e.valueFrom?.generate) {
      if (existing?.generated && existing.value) {
        return {
          name: e.name,
          value: existing.value,
          source: 'manifest',
          secret: true,
          generated: true,
        };
      }
      return {
        name: e.name,
        value: generateRandomSecret(e.valueFrom.length, e.valueFrom.format),
        source: 'manifest',
        secret: true,
        generated: true,
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
   * The public endpoint an `exposure: public` application is owed.
   *
   * Derived from the exposure, never from `deploy.domain`. Reading the domain
   * block as the trigger meant the most common manifest there is — a port, a
   * healthcheck, nothing else — asked for no endpoint at all: build green,
   * image published, pods 1/1, and not one host reachable, with nothing said
   * anywhere. `deploy.domain` is back to what it was always meant to be: the
   * override for an author who wants a name of their own.
   *
   * The hostname itself is minted by `AppEndpointService` through
   * `EndpointModeResolverService` — the cluster's assigned zone when it has
   * one, nip.io off the master IP when it does not — which is the same road
   * the catalog takes.
   *
   * Idempotent: an application that already has endpoints only gets them
   * reconciled again.
   *
   * A public application whose hostname cannot be minted is a deploy that did
   * not succeed, so this throws: the deploy processor fails the operation on
   * it, the same road every other phase failure takes, and the reason is left
   * on the application so the reconciler cannot overwrite the verdict with the
   * pods' own good health.
   */
  async ensurePublicEndpoint(applicationId: string): Promise<void> {
    const app = await this.applicationsRepository.findById(applicationId);
    if (!app) {
      this.logger.warn(
        `ensurePublicEndpoint(${applicationId}): no such application — nothing to expose`,
      );
      return;
    }
    const label = `ensurePublicEndpoint(${app.slug})`;

    // Whatever this run decides replaces what the last one left behind — an
    // application that has since been made internal, or handed an endpoint by
    // hand, must not keep reading as failed.
    await this.clearEndpointFailure(app);

    if (app.exposure !== ApplicationExposure.PUBLIC) {
      this.logger.log(
        `${label}: exposure=${app.exposure} — no public endpoint is owed`,
      );
      return;
    }
    if (app.category === ApplicationCategory.SYSTEM || app.systemProtected) {
      this.logger.log(
        `${label}: system application — the platform owns its ingress, not this path`,
      );
      return;
    }
    const catalogInstallId = app.metadata?.catalogInstallId;
    if (catalogInstallId) {
      this.logger.log(
        `${label}: catalog install ${catalogInstallId} owns this application's endpoint`,
      );
      return;
    }

    const spec = this.readEndpointSpec(app);
    if (!spec) {
      throw await this.endpointFailure(
        app,
        `the stored ${ENDPOINT_SPEC_METADATA_KEY} is not readable JSON, so the domain this manifest declared cannot be honoured`,
      );
    }
    if (spec.auto === false) {
      this.logger.warn(
        `${label}: deploy.domain.auto=false — no endpoint created; the application stays unreachable from outside until one is configured`,
      );
      return;
    }

    // Only a public endpoint discharges what a public application is owed. An
    // application moved from `internal` to `public` still carries its internal
    // row, and counting that one would send this path home having created
    // nothing — the same silence this whole repair exists to remove.
    const existing = (
      await this.appEndpointService.listByApplicationId(applicationId)
    ).filter((ep) => ep.endpointType !== EndpointType.INTERNAL);
    if (existing.length > 0) {
      this.logger.log(
        `${label}: ${existing.length} public endpoint(s) already exist — reconciling them`,
      );
      for (const ep of existing) {
        this.appEndpointReconciliationService
          .reconcile(ep.id)
          .catch((err) =>
            this.logger.warn(
              `${label}: reconcile of existing endpoint ${ep.id} failed: ${errorMessage(err)}`,
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

    let endpoint: AppEndpointEntity;
    try {
      endpoint = await this.appEndpointService.createEndpoint(app.clusterId, {
        applicationId,
        clusterDnsZoneId: assignment?.id,
        certificateRequired: spec.tls !== false,
        ...(spec.fqdn ? { fqdn: spec.fqdn } : {}),
        ...this.endpointOverrides(spec, wildcardIssuer?.certificateProvider),
      });
    } catch (err) {
      throw await this.endpointFailure(app, errorMessage(err));
    }

    this.logger.log(
      `${label}: endpoint created fqdn=${endpoint.fqdn} mode=${endpoint.hostnameMode}/${endpoint.certChallenge} ` +
        `tls=${spec.tls !== false} — ${hostnameOrigin(spec, assignment)}`,
    );

    this.appEndpointReconciliationService
      .reconcile(endpoint.id)
      .catch((err) =>
        this.logger.warn(
          `${label}: reconcile failed for ${endpoint.id}: ${errorMessage(err)}`,
        ),
      );
  }

  /**
   * The `deploy.domain` fields that are an override of how the endpoint is
   * named and certified — the catalog maps its own domain spec the same way.
   * A field the manifest left out is left out here too, so the endpoint
   * resolver decides it.
   */
  private endpointOverrides(
    spec: EndpointSpec,
    wildcardProvider: CertificateProvider | undefined,
  ): {
    hostnameMode?: HostnameMode;
    certChallenge?: CertChallenge;
    certificateProvider?: CertificateProvider;
  } {
    const hostnameMode = HOSTNAME_MODES[spec.hostnameMode ?? ''];
    const certChallenge = CERT_CHALLENGES[spec.certChallenge ?? ''];
    const certificateProvider =
      CERTIFICATE_PROVIDERS[spec.certificateProvider ?? ''] ?? wildcardProvider;
    return {
      ...(hostnameMode ? { hostnameMode } : {}),
      ...(certChallenge ? { certChallenge } : {}),
      ...(certificateProvider ? { certificateProvider } : {}),
    };
  }

  /**
   * The manifest's `deploy.domain` as stored, `{}` when the manifest declared
   * none — the endpoint is owed either way — and `null` when what is stored
   * cannot be read at all, which is a public application whose declared name
   * we would otherwise silently replace with one of our own.
   */
  private readEndpointSpec(app: ApplicationEntity): EndpointSpec | null {
    const raw = app.metadata?.[ENDPOINT_SPEC_METADATA_KEY];
    if (raw === undefined || raw === null || raw === '') return {};
    if (typeof raw === 'object') return raw as EndpointSpec;
    try {
      return JSON.parse(String(raw)) as EndpointSpec;
    } catch {
      return null;
    }
  }

  /**
   * Records why the application has no endpoint and returns the error the
   * deploy fails with. Writing the metadata marker is what keeps the verdict
   * alive past the next reconciliation — see `endpoint-failure.util`. Writing
   * the diagnosis is what puts the same fact where a person actually looks
   * for it — the dashboard's Diagnoses tab — see `EndpointDiagnosisService`.
   * Neither write is allowed to hide the real failure: both are logged and
   * swallowed on their own, the thrown error is unconditional.
   */
  private async endpointFailure(
    app: ApplicationEntity,
    cause: string,
  ): Promise<Error> {
    const reason =
      `exposure: public, but no public endpoint could be created — ${cause}. ` +
      `The application is running and unreachable from outside.`;
    try {
      await this.applicationsRepository.update(app.id, {
        metadata: withEndpointFailure(app.metadata, reason),
      });
    } catch (err) {
      this.logger.warn(
        `ensurePublicEndpoint(${app.slug}): could not record the endpoint failure on the application: ${errorMessage(err)}`,
      );
    }
    try {
      await this.endpointDiagnosisService.record(app, cause);
    } catch (err) {
      this.logger.warn(
        `ensurePublicEndpoint(${app.slug}): could not write the diagnosis for the endpoint failure: ${errorMessage(err)}`,
      );
    }
    this.logger.error(`ensurePublicEndpoint(${app.slug}): ${reason}`);
    return new Error(reason);
  }

  /**
   * The diagnosis is resolved whether or not the marker is still there: an
   * endpoint created by hand already cleared the marker, so a guard on it left
   * the critical diagnosis open for good — on an application anybody could
   * reach.
   */
  private async clearEndpointFailure(app: ApplicationEntity): Promise<void> {
    if (readEndpointFailure(app.metadata)) {
      await this.applicationsRepository.update(app.id, {
        metadata: withoutEndpointFailure(app.metadata),
      });
    }
    try {
      await this.endpointDiagnosisService.resolve(app.id);
    } catch (err) {
      this.logger.warn(
        `ensurePublicEndpoint(${app.slug}): could not resolve the endpoint-failure diagnosis: ${errorMessage(err)}`,
      );
    }
  }
}

const HOSTNAME_MODES: Record<string, HostnameMode | undefined> = {
  ip: HostnameMode.IP,
  domain: HostnameMode.DOMAIN,
};

const CERT_CHALLENGES: Record<string, CertChallenge | undefined> = {
  'http-01': CertChallenge.HTTP_01,
  'dns-01': CertChallenge.DNS_01,
};

const CERTIFICATE_PROVIDERS: Record<string, CertificateProvider | undefined> = {
  'lets-encrypt': CertificateProvider.LETS_ENCRYPT,
  'lets-encrypt-staging': CertificateProvider.LETS_ENCRYPT_STAGING,
};

/** Where the hostname came from, said in the log that records the endpoint. */
function hostnameOrigin(
  spec: EndpointSpec,
  assignment: { dnsZone?: { zoneName?: string } } | null,
): string {
  if (spec.fqdn) return 'fqdn declared by the manifest';
  const zone = assignment?.dnsZone?.zoneName;
  return zone
    ? `minted under the cluster zone ${zone}`
    : 'no cluster zone — minted on nip.io off the master IP';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
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

/**
 * The assignment shape varies by caller. `getZoneAssignment` returns a
 * `ClusterDnsZoneEntity`, which holds the name one level down in its `dnsZone`
 * relation — reading only the top level answered `null` for every cluster,
 * including one with a zone bound and in sync, and the exposure check then told
 * the author their cluster had no zone.
 */
function zoneName(zone: unknown): string | null {
  if (!zone || typeof zone !== 'object') return null;
  const named = zone as {
    zoneName?: string;
    name?: string;
    zone?: string;
    dnsZone?: { zoneName?: string; name?: string };
  };
  return (
    named.zoneName ??
    named.name ??
    named.zone ??
    named.dnsZone?.zoneName ??
    named.dnsZone?.name ??
    null
  );
}
