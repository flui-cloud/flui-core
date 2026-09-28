import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ImageRepository } from '../repositories/image.repository';
import { ImageEntity } from '../entities/image.entity';
import { GhcrTagDto } from '../dto/ghcr.dto';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { RepositoriesRepository } from '../../repositories/repositories/repositories.repository';
import { GhcrPackagesService } from '../../repositories/services/ghcr-packages.service';
import { GitBuildSourceConfig } from '../../applications/interfaces/source-config.interface';
import { ApplicationDeployService } from '../../applications/services/application-deploy.service';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';

@Injectable()
export class ImageRegistryService {
  private readonly logger = new Logger(ImageRegistryService.name);

  constructor(
    private readonly imageRepository: ImageRepository,
    @Inject(forwardRef(() => ApplicationsRepository))
    private readonly applicationsRepository: ApplicationsRepository,
    @Inject(forwardRef(() => RepositoriesRepository))
    private readonly repositoriesRepository: RepositoriesRepository,
    @Inject(forwardRef(() => GhcrPackagesService))
    private readonly ghcrPackagesService: GhcrPackagesService,
    @Inject(forwardRef(() => ApplicationDeployService))
    private readonly applicationDeployService: ApplicationDeployService,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
  ) {}

  private async assertSafeToDeleteVersion(
    app: ApplicationEntity,
    appId: string,
    target: { tags: string[]; digest?: string },
  ): Promise<string | null> {
    const matchesCurrent = this.versionMatchesImageRef(target, app.imageRef);
    if (matchesCurrent) {
      return 'Cannot delete the image version currently deployed. Deploy a different image first.';
    }

    const latestRelease = await this.operationRepository.findOne({
      where: {
        resourceId: appId,
        operationType: In([
          OperationType.DEPLOY_APPLICATION,
          OperationType.ROLLBACK_APPLICATION,
        ]),
        status: OperationStatus.COMPLETED,
      },
      order: { createdAt: 'DESC' },
    });
    const latestImageRef = (
      latestRelease?.metadata as { imageRef?: string } | undefined
    )?.imageRef;
    if (latestImageRef && this.versionMatchesImageRef(target, latestImageRef)) {
      return 'Cannot delete the image of the latest release. Pass force=true to override.';
    }

    return null;
  }

  private versionMatchesImageRef(
    target: { tags: string[]; digest?: string },
    imageRef: string | null | undefined,
  ): boolean {
    if (!imageRef) return false;
    const at = imageRef.indexOf('@');
    const digest =
      at >= 0 && /^sha256:[0-9a-f]{64}$/.test(imageRef.slice(at + 1))
        ? imageRef.slice(at + 1)
        : null;
    if (digest && target.digest === digest) return true;
    if (digest) return false;
    const head = at >= 0 ? imageRef.slice(0, at) : imageRef;
    const lastColon = head.lastIndexOf(':');
    const lastSlash = head.lastIndexOf('/');
    const tag = lastColon > lastSlash ? head.slice(lastColon + 1) : null;
    if (!tag) return false;
    return target.tags.includes(tag);
  }

  async listImages(filters?: {
    appId?: string;
    tag?: string;
    page?: number;
    limit?: number;
  }): Promise<ImageEntity[]> {
    return this.imageRepository.findAll(filters);
  }

  async listImagesByApp(appId: string): Promise<ImageEntity[]> {
    return this.imageRepository.findByAppId(appId);
  }

  async getImage(imageId: string): Promise<ImageEntity> {
    const image = await this.imageRepository.findById(imageId);
    if (!image) throw new NotFoundException('Image not found');
    return image;
  }

  /**
   * Record a new image after a successful build/webhook.
   * Idempotent — upserts by imageRef.
   */
  async recordImage(data: {
    appId: string;
    imageRef: string;
    commitSha: string;
    branch: string;
  }): Promise<ImageEntity> {
    return this.setActiveImage(data.appId, data.imageRef, {
      commitSha: data.commitSha,
      branch: data.branch,
    });
  }

  /**
   * Single source of truth for "this is the image currently deployed for the
   * app". Finds or creates the local row for `imageRef`, clears every other
   * row's flag, and sets this one's flag to true. Idempotent.
   */
  async setActiveImage(
    appId: string,
    imageRef: string,
    hint?: { commitSha?: string; branch?: string },
  ): Promise<ImageEntity> {
    let image = await this.imageRepository.findByImageRef(imageRef);
    if (!image) {
      image = await this.imageRepository.save({
        appId,
        imageRef,
        commitSha: hint?.commitSha ?? '',
        branch: hint?.branch ?? '',
        fluiTags: [],
        isCurrentlyDeployed: false,
      });
      this.logger.log(`Recorded image ${imageRef} for app ${appId}`);
    }
    await this.imageRepository.clearCurrentlyDeployed(appId);
    await this.imageRepository.update(image.id, { isCurrentlyDeployed: true });
    image.isCurrentlyDeployed = true;
    return image;
  }

  async addFluiTag(imageId: string, tag: string): Promise<ImageEntity> {
    const image = await this.getImage(imageId);
    if (image.fluiTags.includes(tag)) {
      return image;
    }
    image.fluiTags = [...image.fluiTags, tag];
    await this.imageRepository.update(imageId, { fluiTags: image.fluiTags });
    return image;
  }

  async removeFluiTag(imageId: string, tag: string): Promise<ImageEntity> {
    const image = await this.getImage(imageId);
    image.fluiTags = image.fluiTags.filter((t) => t !== tag);
    await this.imageRepository.update(imageId, { fluiTags: image.fluiTags });
    return image;
  }

  async markAsDeployed(imageId: string): Promise<void> {
    const image = await this.getImage(imageId);
    await this.imageRepository.clearCurrentlyDeployed(image.appId);
    await this.imageRepository.update(imageId, { isCurrentlyDeployed: true });
  }

  async deleteImage(imageId: string): Promise<void> {
    const image = await this.getImage(imageId);
    if (image.isCurrentlyDeployed) {
      throw new BadRequestException(
        'Cannot delete an image that is currently deployed. Deploy a different image first.',
      );
    }
    await this.imageRepository.delete(imageId);
    this.logger.log(`Deleted image record ${imageId} (${image.imageRef})`);
  }

  // ── GHCR Registry Management ──────────────────────────────────────────

  async listGhcrTagsForApp(
    appId: string,
    userId: string,
  ): Promise<GhcrTagDto[]> {
    const { owner, packageName, app } = await this.resolveGhcrContext(
      appId,
      userId,
    );

    const [ghcrTags, localImages] = await Promise.all([
      this.listGhcrTagsForRepo(owner, packageName, app.userId),
      this.imageRepository.findByAppId(appId),
    ]);

    const localByShortSha = new Map<string, ImageEntity>();
    const localByDigest = new Map<string, ImageEntity>();
    for (const img of localImages) {
      const sha = img.commitSha.slice(0, 7);
      localByShortSha.set(sha, img);
      const digest = this.extractDigest(img.imageRef);
      if (digest) localByDigest.set(digest, img);
    }

    return ghcrTags.map((t) => {
      const localByTag = t.tags
        .map((tag) => localByShortSha.get(tag))
        .find(Boolean);
      const local =
        localByTag ?? (t.digest ? localByDigest.get(t.digest) : undefined);
      return {
        ...t,
        isCurrentlyDeployed: local?.isCurrentlyDeployed ?? false,
        hasLocalRecord: !!local,
        localImageId: local?.id,
        fluiTags: local?.fluiTags ?? [],
      };
    });
  }

  private extractDigest(imageRef: string | undefined | null): string | null {
    if (!imageRef) return null;
    const at = imageRef.lastIndexOf('@');
    if (at < 0) return null;
    const candidate = imageRef.slice(at + 1);
    return /^sha256:[0-9a-f]{64}$/.test(candidate) ? candidate : null;
  }

  /**
   * List GHCR package versions for an arbitrary owner/repo without requiring
   * an Application entity. Used by RAW_MANIFEST system apps whose images live
   * on GHCR but aren't bound to a Flui repository.
   *
   * Requires the user to have a GitHub App installation on the owner org.
   * For third-party public repos (zitadel/zitadel etc.) use
   * listGhcrTagsViaRegistryApi() instead.
   */
  async listGhcrTagsForRepo(
    owner: string,
    packageName: string,
    userId: string,
  ): Promise<GhcrTagDto[]> {
    const ghcrVersions = await this.ghcrPackagesService.listVersions(
      userId,
      owner,
      packageName,
    );
    return ghcrVersions.map((v) => ({
      versionId: v.versionId,
      digest: v.digest,
      tags: v.tags,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
      htmlUrl: v.htmlUrl,
      imageRef:
        v.tags.length > 0
          ? `ghcr.io/${owner}/${packageName}:${v.tags[0]}`
          : `ghcr.io/${owner}/${packageName}@${v.digest}`,
      isCurrentlyDeployed: false,
      hasLocalRecord: false,
      fluiTags: [],
    }));
  }

  /**
   * List GHCR tags for a public package via the anonymous Docker Registry v2
   * API. Used for RAW_MANIFEST system apps whose images live on GHCR but
   * are not bound to a Flui-managed GitHub repository.
   *
   * Works for:
   *   - Third-party orgs (zitadel/zitadel, etc.) — no GitHub App needed
   *   - Private GitHub orgs whose GHCR packages are public (flui-cloud/*)
   *
   * Pagination: GHCR returns tags in arbitrary (often ascending) order with
   * no Link header. We iterate via the `?last=` cursor up to `maxPages`. For
   * zitadel-scale repos (~5000 tags) this is ~5 round-trips; the caller's
   * allowedVersions filter then narrows to the relevant subset.
   */
  async listGhcrTagsViaRegistryApi(
    owner: string,
    packageName: string,
    maxPages = 10,
  ): Promise<GhcrTagDto[]> {
    const repoPath = `${owner}/${packageName}`;
    const tokenResp = await fetch(
      `https://ghcr.io/token?scope=repository:${repoPath}:pull`,
    );
    if (!tokenResp.ok) {
      throw new Error(
        `GHCR token request failed for ${repoPath}: HTTP ${tokenResp.status}`,
      );
    }
    const { token } = (await tokenResp.json()) as { token: string };
    const headers = { Authorization: `Bearer ${token}` };

    const PAGE_SIZE = 1000;
    const allTags: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < maxPages; page++) {
      const url = cursor
        ? `https://ghcr.io/v2/${repoPath}/tags/list?n=${PAGE_SIZE}&last=${encodeURIComponent(cursor)}`
        : `https://ghcr.io/v2/${repoPath}/tags/list?n=${PAGE_SIZE}`;
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        if (resp.status === 404) return [];
        throw new Error(
          `GHCR tag list failed for ${repoPath}: HTTP ${resp.status}`,
        );
      }
      const body = (await resp.json()) as { tags: string[] | null };
      const pageTags = body.tags ?? [];
      if (pageTags.length === 0) break;
      allTags.push(...pageTags);
      if (pageTags.length < PAGE_SIZE) break;
      cursor = pageTags.at(-1);
    }

    return allTags.map((t) => ({
      versionId: 0,
      digest: '',
      tags: [t],
      createdAt: '',
      updatedAt: '',
      htmlUrl: `https://github.com/${owner}/${packageName}/pkgs/container/${packageName}`,
      imageRef: `ghcr.io/${repoPath}:${t}`,
      isCurrentlyDeployed: false,
      hasLocalRecord: false,
      fluiTags: [],
    }));
  }

  async resolveGhcrTagDigest(
    owner: string,
    packageName: string,
    tag: string,
  ): Promise<string | null> {
    const repoPath = `${owner}/${packageName}`;
    const tokenResp = await fetch(
      `https://ghcr.io/token?scope=repository:${repoPath}:pull`,
    );
    if (!tokenResp.ok) return null;
    const { token } = (await tokenResp.json()) as { token: string };
    const resp = await fetch(
      `https://ghcr.io/v2/${repoPath}/manifests/${encodeURIComponent(tag)}`,
      {
        method: 'HEAD',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: [
            'application/vnd.oci.image.index.v1+json',
            'application/vnd.oci.image.manifest.v1+json',
            'application/vnd.docker.distribution.manifest.list.v2+json',
            'application/vnd.docker.distribution.manifest.v2+json',
          ].join(', '),
        },
      },
    );
    if (!resp.ok) return null;
    return resp.headers.get('docker-content-digest');
  }

  async deleteGhcrTagForApp(
    appId: string,
    versionId: number,
    userId: string,
    options?: { force?: boolean },
  ): Promise<void> {
    const { owner, packageName, app } = await this.resolveGhcrContext(
      appId,
      userId,
    );

    const versions = await this.ghcrPackagesService.listVersions(
      app.userId,
      owner,
      packageName,
    );
    const target = versions.find((v) => v.versionId === versionId);
    if (!target) {
      throw new NotFoundException('Package version not found on GHCR');
    }

    if (this.versionMatchesImageRef(target, app.imageRef)) {
      throw new BadRequestException(
        'Cannot delete the image version currently deployed. Deploy a different image first.',
      );
    }
    if (!options?.force) {
      const blockReason = await this.assertSafeToDeleteVersion(
        app,
        appId,
        target,
      );
      if (blockReason) {
        throw new BadRequestException(blockReason);
      }
    }

    await this.ghcrPackagesService.deleteVersion(
      app.userId,
      owner,
      packageName,
      versionId,
    );

    const locals = await this.imageRepository.findByAppId(appId);
    for (const tag of target.tags) {
      const local = locals.find((l) => l.commitSha.startsWith(tag));
      if (local && !local.isCurrentlyDeployed) {
        await this.imageRepository.delete(local.id);
      }
    }
    if (target.digest) {
      const localByDigest = locals.find(
        (l) => this.extractDigest(l.imageRef) === target.digest,
      );
      if (localByDigest && !localByDigest.isCurrentlyDeployed) {
        await this.imageRepository.delete(localByDigest.id);
      }
    }

    this.logger.log(
      `Deleted GHCR version ${versionId} (tags=${target.tags.join(',') || '(untagged)'}, digest=${target.digest ?? 'n/a'}) for app ${appId}${options?.force ? ' [forced]' : ''}`,
    );
  }

  /** Access (`app:deploy`) is checked by the route. */
  async redeployGhcrTag(appId: string, tag: string) {
    const app = await this.applicationsRepository.findById(appId);
    if (!app) throw new NotFoundException('Application not found');
    const { owner, packageName } = await this.ghcrContextFor(app);

    const versions = await this.ghcrPackagesService.listVersions(
      app.userId,
      owner,
      packageName,
    );

    const isDigestRef = /^sha256:[0-9a-f]{64}$/.test(tag);
    const isShortDigest = !isDigestRef && /^[0-9a-f]{12,64}$/.test(tag);

    let imageRef: string;
    if (isDigestRef || isShortDigest) {
      const match = versions.find((v) =>
        isDigestRef
          ? v.digest === tag
          : v.digest?.replace(/^sha256:/, '').startsWith(tag),
      );
      if (!match) {
        throw new NotFoundException(
          `No GHCR version matches digest "${tag}" for ${owner}/${packageName}`,
        );
      }
      imageRef = `ghcr.io/${owner}/${packageName}@${match.digest}`;
    } else {
      const exists = versions.some((v) => v.tags.includes(tag));
      if (!exists) {
        throw new NotFoundException(`Tag "${tag}" not found on GHCR`);
      }
      imageRef = `ghcr.io/${owner}/${packageName}:${tag}`;
    }

    const op = await this.applicationDeployService.triggerDeployWithImage(
      app.id,
      imageRef,
      app.userId,
    );
    await this.setActiveImage(app.id, imageRef);
    return op;
  }

  async deployImageById(imageId: string, userId: string) {
    const image = await this.getImage(imageId);
    const app = await this.applicationsRepository.findById(image.appId);
    if (!app) throw new NotFoundException('Application not found');

    const op = await this.applicationDeployService.triggerDeployWithImage(
      app.id,
      image.imageRef,
      userId,
    );
    await this.setActiveImage(app.id, image.imageRef);
    return op;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private async resolveGhcrContext(appId: string, userId: string) {
    const app = await this.applicationsRepository.findById(appId);
    if (!app) throw new NotFoundException('Application not found');
    if (app.userId !== userId)
      throw new ForbiddenException('Not owner of this application');
    return this.ghcrContextFor(app);
  }

  private async ghcrContextFor(app: ApplicationEntity) {
    const repositoryId = (app.sourceConfig as GitBuildSourceConfig)
      ?.repositoryId;
    if (!repositoryId) {
      throw new BadRequestException(
        'Application is not linked to a repository',
      );
    }

    const repository = await this.repositoriesRepository.findById(repositoryId);
    if (!repository) throw new NotFoundException('Linked repository not found');

    // Prefer parsing owner/packageName from the actual deployed imageRef:
    // it's the authoritative source for where the package was published, and
    // survives slug renames or workflow naming-scheme changes (which would
    // otherwise yield a 404 because `flui-${app.slug}` no longer matches).
    // Fall back to the slug-based name only for apps that have never deployed.
    const parsed = this.parseGhcrImageRef(app.imageRef);
    const owner = parsed?.owner ?? repository.owner.toLowerCase();
    const packageName = parsed?.packageName ?? `flui-${app.slug}`;

    return { owner, packageName, app, repository };
  }

  /**
   * Parse "ghcr.io/<owner>/<packageName>:<tag>" → { owner, packageName }.
   * Returns null for non-GHCR refs or malformed strings.
   */
  private parseGhcrImageRef(
    imageRef: string | undefined | null,
  ): { owner: string; packageName: string } | null {
    if (!imageRef) return null;
    const noTag = imageRef.split('@')[0].split(':')[0];
    if (!noTag.startsWith('ghcr.io/')) return null;
    const path = noTag.slice('ghcr.io/'.length);
    const slashIdx = path.indexOf('/');
    if (slashIdx <= 0) return null;
    const owner = path.slice(0, slashIdx).toLowerCase();
    const packageName = path.slice(slashIdx + 1);
    if (!owner || !packageName) return null;
    return { owner, packageName };
  }
}
