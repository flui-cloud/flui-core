import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { ImageRegistryService } from '../../image-registry/services/image-registry.service';
import { DockerHubService } from '../../images/services/dockerhub.service';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import {
  AvailableVersionDto,
  AvailableVersionsResponseDto,
} from '../dto/available-versions.dto';
import {
  findSystemAppByLabel,
  SystemAppImageSource,
} from '../constants/system-app-catalog';
import { ApplicationEntity } from '../entities/application.entity';
import { matchesAnyPattern } from '../utils/version-pattern';
import { sortVersionsForDisplay } from '../utils/version-ordering.util';
import { ApplicationReleaseService } from './application-release.service';
import { ApplicationReleaseDto } from '../dto/application-release.dto';
import { GhcrTagDto } from '../../image-registry/dto/ghcr.dto';

const PLATFORM_CHILD_WINDOW_MS = 10_000;

@Injectable()
export class ApplicationVersionsService {
  private readonly logger = new Logger(ApplicationVersionsService.name);

  constructor(
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly imageRegistryService: ImageRegistryService,
    private readonly dockerHubService: DockerHubService,
    private readonly releaseService: ApplicationReleaseService,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
  ) {}

  /**
   * Reads the running pod's `containerStatuses[].imageID` to get the *real*
   * image currently executing in the cluster, instead of the (possibly stale)
   * `app.imageRef` string from the Deployment spec. The imageRef may say
   * `:latest` while the pod still has an older digest cached — without this
   * resolver, the UI marks the wrong version as "Currently deployed".
   *
   * Returns the canonical `<image>@sha256:...` ref on success, or `null` when
   * the cluster query fails, the namespace is missing, or no pod is running.
   * Callers fall back to `app.imageRef`.
   */
  private async resolveRunningImageRef(app: {
    id: string;
    slug?: string | null;
    clusterId?: string | null;
    k8sNamespace?: string | null;
  }): Promise<string | null> {
    if (!app.clusterId || !app.k8sNamespace) return null;
    try {
      const cluster = await this.clusterRepository.findOne({
        where: { id: app.clusterId },
      });
      if (!cluster?.kubeconfigEncrypted) return null;
      const kubeconfig = this.encryptionService.decrypt(
        cluster.kubeconfigEncrypted,
      );

      // GIT_BUILD apps use `flui-app-id=<id>` (set by the manifest generator).
      // RAW_MANIFEST system apps come from static YAML and don't carry that
      // label on the pod template — try common fallbacks based on the app
      // slug, which matches `app.kubernetes.io/instance` / `app` across
      // system manifests (e.g. flui-api, zitadel, grafana).
      const selectors = [
        `flui-app-id=${app.id}`,
        ...(app.slug
          ? [`app.kubernetes.io/instance=${app.slug}`, `app=${app.slug}`]
          : []),
      ];

      for (const selector of selectors) {
        const pods = await this.kubernetesService.listPodsByLabel(
          kubeconfig,
          app.k8sNamespace,
          selector,
        );
        if (pods.length === 0) continue;
        const running = pods.find((p) => p.status?.phase === 'Running');
        const candidate = running ?? pods[0];
        const imageID = candidate?.status?.containerStatuses?.[0]?.imageID;
        if (imageID) return this.normalizeImageID(imageID);
      }
      return null;
    } catch (err) {
      this.logger.debug(
        `resolveRunningImageRef failed for app ${app.id}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * containerStatuses[i].imageID typically looks like
   * `docker-pullable://ghcr.io/foo/bar@sha256:abc...` or `ghcr.io/foo/bar@sha256:...`
   * depending on the container runtime. Strip the `docker-pullable://` prefix
   * so downstream digest parsing matches what the registry returns.
   */
  private normalizeImageID(imageID: string): string {
    return imageID.replace(/^docker-pullable:\/\//, '');
  }

  /**
   * Builds a per-image join of recent releases. Indexed by digest first
   * (canonical, immutable) and tag as a fallback for releases triggered on
   * tag-pinned imageRefs. Each version also picks up the global "latest
   * release" pointer so we can flag it in the UI.
   */
  private buildReleaseLookup(releases: ApplicationReleaseDto[]): {
    byDigest: Map<string, ApplicationReleaseDto[]>;
    byTag: Map<string, ApplicationReleaseDto[]>;
    latestOperationId: string | null;
  } {
    const byDigest = new Map<string, ApplicationReleaseDto[]>();
    const byTag = new Map<string, ApplicationReleaseDto[]>();
    for (const r of releases) {
      const parsed = this.parseImageRef(r.imageRef ?? '');
      if (parsed.digest) {
        const arr = byDigest.get(parsed.digest) ?? [];
        arr.push(r);
        byDigest.set(parsed.digest, arr);
      }
      if (parsed.tag) {
        const arr = byTag.get(parsed.tag) ?? [];
        arr.push(r);
        byTag.set(parsed.tag, arr);
      }
    }
    return {
      byDigest,
      byTag,
      latestOperationId: releases[0]?.operationId ?? null,
    };
  }

  private matchReleases(
    version: { digest?: string; tag?: string; allTags?: string[] },
    lookup: ReturnType<typeof this.buildReleaseLookup>,
  ): ApplicationReleaseDto[] {
    const seen = new Set<string>();
    const out: ApplicationReleaseDto[] = [];
    const push = (rels: ApplicationReleaseDto[] | undefined): void => {
      if (!rels) return;
      for (const r of rels) {
        if (seen.has(r.operationId)) continue;
        seen.add(r.operationId);
        out.push(r);
      }
    };
    if (version.digest) push(lookup.byDigest.get(version.digest));
    const tags = [version.tag, ...(version.allTags ?? [])].filter(
      (t): t is string => !!t,
    );
    for (const t of tags) push(lookup.byTag.get(t));
    out.sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt));
    return out;
  }

  private async enrichWithReleases(
    appId: string,
    versions: AvailableVersionDto[],
  ): Promise<AvailableVersionDto[]> {
    const releases = await this.releaseService.listReleases(appId, 50);
    const lookup = this.buildReleaseLookup(releases);
    return versions.map((v) => {
      const matched = this.matchReleases(v, lookup);
      const lastRelease = matched[0] ?? null;
      return {
        ...v,
        lastRelease,
        releaseCount: matched.length,
        isLatestRelease:
          !!lastRelease && lastRelease.operationId === lookup.latestOperationId,
      };
    });
  }

  async getAvailableVersions(
    appId: string,
    userId: string,
    page = 1,
    limit = 25,
  ): Promise<AvailableVersionsResponseDto> {
    const app = await this.applicationsRepository.findById(appId);
    if (!app) throw new NotFoundException(`Application ${appId} not found`);

    let response: AvailableVersionsResponseDto;
    if (app.sourceType === ApplicationSourceType.GIT_BUILD) {
      response = await this.listForGitBuild(app, userId);
    } else if (app.sourceType === ApplicationSourceType.DOCKER_IMAGE) {
      const imageName = this.extractImageName(app.imageRef ?? '');
      response = await this.listFromDockerHub(
        app,
        imageName,
        page,
        limit,
        null,
      );
    } else if (app.sourceType === ApplicationSourceType.RAW_MANIFEST) {
      response = await this.listForRawManifestSystemApp(
        app,
        page,
        limit,
        userId,
      );
    } else {
      response = this.emptyResponse(app, null);
    }

    return this.applyCurrentlyDeployedFromCurrentImageRef(response, app);
  }

  /**
   * Single source of truth for the `isCurrentlyDeployed` flag in the listing:
   * the response's own `currentImageRef`. Compares each version against that
   * canonical ref by digest first (immutable), then by tag (`tag` + `allTags`).
   * Guarantees at most one row is flagged true. Prevents drift between the
   * local `images` table and what the workload actually serves — the listing
   * is just a view, the flag must reflect the current top-level field.
   *
   * Before matching, attempts to upgrade `response.currentImageRef` to the
   * digest the cluster pod is actually executing (via the k8s API), so that
   * a stale `:latest` tag on the Deployment spec does not mislead the UI
   * when the pod still has an older digest cached locally on the node.
   */
  private async applyCurrentlyDeployedFromCurrentImageRef(
    response: AvailableVersionsResponseDto,
    app: {
      id: string;
      slug?: string | null;
      clusterId?: string | null;
      k8sNamespace?: string | null;
    },
  ): Promise<AvailableVersionsResponseDto> {
    const runningRef = await this.resolveRunningImageRef(app);
    if (runningRef) {
      response = { ...response, currentImageRef: runningRef };
    }
    const current = this.parseImageRef(response.currentImageRef ?? '');
    if (!current.digest && !current.tag) {
      return {
        ...response,
        versions: sortVersionsForDisplay(
          response.versions.map((v) => ({
            ...v,
            isCurrentlyDeployed: false,
          })),
        ),
      };
    }
    let alreadyFlagged = false;
    const versions = response.versions.map((v) => {
      if (alreadyFlagged) {
        return { ...v, isCurrentlyDeployed: false };
      }
      const matchesDigest =
        !!current.digest && !!v.digest && v.digest === current.digest;
      const matchesTag =
        !current.digest &&
        !!current.tag &&
        (v.tag === current.tag || (v.allTags ?? []).includes(current.tag));
      const isCurrent = matchesDigest || matchesTag;
      if (isCurrent) alreadyFlagged = true;
      return { ...v, isCurrentlyDeployed: isCurrent };
    });
    return { ...response, versions: sortVersionsForDisplay(versions) };
  }

  // Hides platform-specific manifests of a multi-platform buildx push (the
  // manifest list and its children are pushed within seconds of each other).
  private filterPlatformChildren(versions: GhcrTagDto[]): GhcrTagDto[] {
    const taggedTimestamps = versions
      .filter((v) => v.tags.length > 0 && v.createdAt)
      .map((v) => +new Date(v.createdAt));
    if (taggedTimestamps.length === 0) return versions;
    return versions.filter((v) => {
      if (v.tags.length > 0) return true;
      if (!v.createdAt) return true;
      const t = +new Date(v.createdAt);
      const hasTaggedSibling = taggedTimestamps.some(
        (tt) => Math.abs(tt - t) <= PLATFORM_CHILD_WINDOW_MS,
      );
      return !hasTaggedSibling;
    });
  }

  private async listForGitBuild(
    app: ApplicationEntity,
    userId: string,
  ): Promise<AvailableVersionsResponseDto> {
    const ghcrVersions = await this.imageRegistryService.listGhcrTagsForApp(
      app.id,
      userId,
    );
    const deployable = this.filterPlatformChildren(ghcrVersions);
    const baseImage = this.extractImageName(app.imageRef ?? '');
    const rawVersions: AvailableVersionDto[] = deployable.map((v) => {
      if (v.tags.length === 0) {
        const digestId = this.shortDigest(v.digest);
        return {
          tag: digestId,
          imageRef: v.digest ? `${baseImage}@${v.digest}` : baseImage,
          versionId: v.versionId,
          allTags: [],
          isCurrentlyDeployed: v.isCurrentlyDeployed,
          createdAt: v.createdAt,
          digest: v.digest,
          lastRelease: null,
          releaseCount: 0,
          isLatestRelease: false,
        };
      }
      const primaryTag = this.selectPrimaryTag(v.tags);
      return {
        tag: primaryTag,
        imageRef: `${baseImage}:${primaryTag}`,
        versionId: v.versionId,
        allTags: v.tags,
        isCurrentlyDeployed: v.isCurrentlyDeployed,
        createdAt: v.createdAt,
        digest: v.digest,
        lastRelease: null,
        releaseCount: 0,
        isLatestRelease: false,
      };
    });
    const versions = await this.enrichWithReleases(app.id, rawVersions);
    return {
      sourceType: app.sourceType,
      currentImageRef: app.imageRef ?? null,
      versions,
      nextPage: null,
      allowedPatterns: null,
    };
  }

  private shortDigest(digest: string | undefined | null): string {
    if (!digest) return '';
    const hex = digest.replace(/^sha256:/, '');
    return hex.slice(0, 12);
  }

  private async listForRawManifestSystemApp(
    app: ApplicationEntity,
    page: number,
    limit: number,
    userId: string,
  ): Promise<AvailableVersionsResponseDto> {
    const label = app.labels?.['app'] ?? app.slug;
    const def = findSystemAppByLabel(label);
    if (!def?.imageSource) {
      return this.emptyResponse(app, null);
    }

    const imageSource = def.imageSource;
    const allowedPatterns = imageSource.allowedVersions ?? [];

    if (imageSource.registry === 'ghcr') {
      const rawVersions = await this.fetchGhcrSystemAppVersions(
        app,
        imageSource,
        userId,
      );
      const versions = await this.enrichWithReleases(app.id, rawVersions);
      return {
        sourceType: app.sourceType,
        currentImageRef: app.imageRef ?? null,
        versions,
        nextPage: null,
        allowedPatterns,
      };
    }

    if (imageSource.registry === 'dockerhub') {
      return this.listFromDockerHub(
        app,
        imageSource.repository,
        page,
        limit,
        allowedPatterns,
      );
    }

    return this.emptyResponse(app, allowedPatterns);
  }

  private async fetchGhcrSystemAppVersions(
    app: ApplicationEntity,
    imageSource: SystemAppImageSource,
    userId: string,
  ): Promise<AvailableVersionDto[]> {
    const slashIdx = imageSource.repository.indexOf('/');
    const ghcrOwner = imageSource.repository.slice(0, slashIdx);
    const ghcrPackage = imageSource.repository.slice(slashIdx + 1);
    // Prefer the authenticated GitHub Packages API (returns createdAt /
    // updatedAt / digests). Fall back to the anonymous Docker Registry v2
    // for orgs the user has no GitHub App installation on (third-party public
    // repos like zitadel/zitadel, mlflow, etc.).
    let ghcrTags: GhcrTagDto[] = [];
    try {
      ghcrTags = await this.imageRegistryService.listGhcrTagsForRepo(
        ghcrOwner,
        ghcrPackage,
        userId,
      );
    } catch (err) {
      this.logger.debug(
        `Authenticated GHCR listing failed for ${ghcrOwner}/${ghcrPackage} (${(err as Error).message}); falling back to anonymous registry API.`,
      );
      ghcrTags = await this.imageRegistryService.listGhcrTagsViaRegistryApi(
        ghcrOwner,
        ghcrPackage,
      );
    }
    const currentTag = this.extractTag(app.imageRef ?? '');
    const allowedPatterns = imageSource.allowedVersions ?? [];
    const filtered = ghcrTags.filter((v) =>
      matchesAnyPattern(v.tags[0], allowedPatterns),
    );

    const resolved = await Promise.all(
      filtered.map(async (v) => {
        const tag = v.tags[0];
        const digest = await this.imageRegistryService.resolveGhcrTagDigest(
          ghcrOwner,
          ghcrPackage,
          tag,
        );
        return { v, tag, digest };
      }),
    );

    type Bucket = {
      digest: string | null;
      tags: string[];
      sample: GhcrTagDto;
    };
    const buckets = new Map<string, Bucket>();
    let unresolvedIdx = 0;
    for (const { v, tag, digest } of resolved) {
      const key = digest ?? `__no_digest_${unresolvedIdx++}__`;
      const existing = buckets.get(key);
      if (existing) {
        existing.tags.push(tag);
      } else {
        buckets.set(key, { digest, tags: [tag], sample: v });
      }
    }

    const baseImage = `ghcr.io/${ghcrOwner}/${ghcrPackage}`;
    return [...buckets.values()].map((b) => {
      const primaryTag = this.selectPrimaryTag(b.tags);
      return {
        tag: primaryTag,
        imageRef: `${baseImage}:${primaryTag}`,
        versionId: b.sample.versionId,
        allTags: b.tags,
        isCurrentlyDeployed:
          primaryTag === currentTag || b.tags.includes(currentTag),
        createdAt: b.sample.createdAt,
        digest: b.digest ?? '',
        lastRelease: null,
        releaseCount: 0,
        isLatestRelease: false,
      };
    });
  }

  private async listFromDockerHub(
    app: ApplicationEntity,
    repository: string,
    page: number,
    limit: number,
    allowedPatterns: string[] | null,
  ): Promise<AvailableVersionsResponseDto> {
    const currentTag = this.extractTag(app.imageRef ?? '');
    const result = await this.dockerHubService.listTags(
      repository,
      page,
      limit,
    );
    let mapped: AvailableVersionDto[] = result.tags.map((t) => ({
      tag: t.name,
      imageRef: `${repository}:${t.name}`,
      allTags: [t.name],
      isCurrentlyDeployed: t.name === currentTag,
      createdAt: t.lastUpdated,
      digest: t.digest,
      deployHint: t.deployHint,
      platforms: t.platforms,
      lastRelease: null,
      releaseCount: 0,
      isLatestRelease: false,
    }));
    if (allowedPatterns && allowedPatterns.length > 0) {
      mapped = mapped.filter((v) => matchesAnyPattern(v.tag, allowedPatterns));
    }
    const versions = await this.enrichWithReleases(app.id, mapped);
    return {
      sourceType: app.sourceType,
      currentImageRef: app.imageRef ?? null,
      versions,
      nextPage: result.nextPage,
      allowedPatterns,
    };
  }

  private emptyResponse(
    app: ApplicationEntity,
    allowedPatterns: string[] | null,
  ): AvailableVersionsResponseDto {
    return {
      sourceType: app.sourceType,
      currentImageRef: app.imageRef ?? null,
      versions: [],
      nextPage: null,
      allowedPatterns,
    };
  }

  private selectPrimaryTag(tags: string[]): string {
    const semver = tags.find((t) => /^\d+\.\d+/.test(t));
    if (semver) return semver;
    const sha = tags.find((t) => /^[0-9a-f]{7,8}$/.test(t));
    if (sha) return sha;
    return tags.find((t) => t !== 'latest') ?? tags[0] ?? '';
  }

  private extractImageName(imageRef: string): string {
    const parsed = this.parseImageRef(imageRef);
    return parsed.repo;
  }

  private extractTag(imageRef: string): string {
    return this.parseImageRef(imageRef).tag ?? 'latest';
  }

  /**
   * Splits an image reference into its three logical parts. Handles every
   * shape we emit or accept:
   *   - registry/repo
   *   - registry/repo:tag
   *   - registry/repo@sha256:<64hex>
   *   - registry/repo:tag@sha256:<64hex>  (rare but legal)
   * `tag` is null when the ref is digest-pinned. `digest` is null when not.
   * `repo` is always free of any `:tag` or `@sha256:...` suffix.
   */
  private parseImageRef(imageRef: string): {
    repo: string;
    tag: string | null;
    digest: string | null;
  } {
    if (!imageRef) return { repo: '', tag: null, digest: null };
    const at = imageRef.indexOf('@');
    const digest =
      at >= 0 && /^sha256:[0-9a-f]{64}$/.test(imageRef.slice(at + 1))
        ? imageRef.slice(at + 1)
        : null;
    const head = at >= 0 ? imageRef.slice(0, at) : imageRef;
    const lastColon = head.lastIndexOf(':');
    const lastSlash = head.lastIndexOf('/');
    if (lastColon > lastSlash) {
      return {
        repo: head.slice(0, lastColon),
        tag: head.slice(lastColon + 1),
        digest,
      };
    }
    return { repo: head, tag: null, digest };
  }
}
