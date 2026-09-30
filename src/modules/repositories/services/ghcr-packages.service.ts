import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { Octokit } from '@octokit/rest';
import { GitHubTokenResolverService } from './github-token-resolver.service';
import { GithubAppUserAuthService } from './github-app-user-auth.service';

export interface GhcrPackageVersion {
  versionId: number;
  digest: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

@Injectable()
export class GhcrPackagesService {
  private readonly logger = new Logger(GhcrPackagesService.name);
  private readonly ownerTypeCache = new Map<string, 'User' | 'Organization'>();

  constructor(
    private readonly tokenResolver: GitHubTokenResolverService,
    private readonly userAuth: GithubAppUserAuthService,
  ) {}

  /**
   * GHCR container-package endpoints require a classic PAT with read:packages
   * (or write/delete) — GitHub App installation tokens and U2S tokens cannot
   * read user/org-owned container packages. Prefer the stored GHCR PAT when
   * present, falling back to the resolver token (works only for legacy
   * same-owner setups).
   */
  private async getOctokitForGhcr(
    userId: string,
    owner: string,
  ): Promise<Octokit> {
    const pat = await this.userAuth.getDecryptedGhcrPat(userId);
    if (pat) {
      return new Octokit({ auth: pat });
    }
    return this.tokenResolver.getOctokit(userId, owner);
  }

  /**
   * Returns the most recently updated tag for a GHCR container package, or
   * null if the package doesn't exist or has no tagged versions.
   *
   * Used by the source-deploy "use latest image" recovery path: when the
   * application has been deleted from Flui but the GHCR package still has
   * builds from previous deploys, this lets `flui deploy --no-build` (or
   * `flui deploy --image latest`) recover without rebuilding.
   *
   * Versions are returned by GitHub already sorted by `updated_at DESC`.
   * `digest`-only versions (no tag) are skipped.
   */
  async getLatestTag(
    userId: string,
    owner: string,
    packageName: string,
  ): Promise<string | null> {
    this.logger.log(`getLatestTag: looking up ${owner}/${packageName} on GHCR`);
    let versions: GhcrPackageVersion[];
    try {
      versions = await this.listVersions(userId, owner, packageName);
    } catch (err) {
      if (err instanceof NotFoundException) {
        this.logger.warn(
          `getLatestTag: package ${owner}/${packageName} not found on GHCR (404)`,
        );
        return null;
      }
      this.logger.error(
        `getLatestTag: failed for ${owner}/${packageName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    this.logger.log(
      `getLatestTag: found ${versions.length} versions for ${owner}/${packageName}`,
    );
    for (const v of versions) {
      const firstTag = v.tags.find((t) => t && t !== 'latest');
      if (firstTag) {
        this.logger.log(
          `getLatestTag: latest tag for ${owner}/${packageName} = ${firstTag}`,
        );
        return firstTag;
      }
    }
    this.logger.warn(
      `getLatestTag: ${versions.length} versions but no tagged ones for ${owner}/${packageName}`,
    );
    return null;
  }

  async listVersions(
    userId: string,
    owner: string,
    packageName: string,
  ): Promise<GhcrPackageVersion[]> {
    const octokit = await this.getOctokitForGhcr(userId, owner);
    const ownerType = await this.resolveOwnerType(octokit, owner);

    try {
      const method =
        ownerType === 'Organization'
          ? octokit.packages.getAllPackageVersionsForPackageOwnedByOrg
          : octokit.packages.getAllPackageVersionsForPackageOwnedByUser;

      const params = {
        package_type: 'container' as const,
        package_name: packageName,
        ...(ownerType === 'Organization'
          ? { org: owner }
          : { username: owner }),
        per_page: 100,
      };

      const versions = await octokit.paginate(method, params);

      return versions.map((v: any) => ({
        versionId: v.id,
        digest: v.name,
        tags: v.metadata?.container?.tags ?? [],
        createdAt: v.created_at,
        updatedAt: v.updated_at,
        htmlUrl: v.html_url ?? '',
      }));
    } catch (err) {
      this.mapGithubError(err, `list versions for ${owner}/${packageName}`);
    }
  }

  async deleteVersion(
    userId: string,
    owner: string,
    packageName: string,
    versionId: number,
  ): Promise<void> {
    const octokit = await this.getOctokitForGhcr(userId, owner);
    const ownerType = await this.resolveOwnerType(octokit, owner);

    try {
      if (ownerType === 'Organization') {
        await octokit.packages.deletePackageVersionForOrg({
          package_type: 'container',
          package_name: packageName,
          org: owner,
          package_version_id: versionId,
        });
      } else {
        await octokit.packages.deletePackageVersionForUser({
          package_type: 'container',
          package_name: packageName,
          username: owner,
          package_version_id: versionId,
        });
      }

      this.logger.log(
        `Deleted GHCR version ${versionId} for ${owner}/${packageName}`,
      );
    } catch (err) {
      this.mapGithubError(
        err,
        `delete version ${versionId} for ${owner}/${packageName}`,
      );
    }
  }

  private async resolveOwnerType(
    octokit: Octokit,
    owner: string,
  ): Promise<'User' | 'Organization'> {
    const cached = this.ownerTypeCache.get(owner.toLowerCase());
    if (cached) return cached;

    try {
      const { data } = await octokit.users.getByUsername({ username: owner });
      const type = data.type as 'User' | 'Organization';
      this.ownerTypeCache.set(owner.toLowerCase(), type);
      return type;
    } catch {
      // Default to User if lookup fails
      return 'User';
    }
  }

  private mapGithubError(err: any, context: string): never {
    const status = err.status ?? err.response?.status;
    const message = err.message ?? 'Unknown GitHub API error';

    switch (status) {
      case 404:
        throw new NotFoundException(`Package not found on GHCR: ${context}`);
      case 403: {
        const isDelete = context.startsWith('delete ');
        const required = isDelete
          ? 'read:packages + delete:packages'
          : 'read:packages + write:packages';
        throw new ForbiddenException(
          `Insufficient permissions for ${context}. The GitHub token Flui uses for packages must be a classic personal access token with the ${required} scopes. Replace it on the Repositories page of the dashboard.`,
        );
      }
      case 401:
        throw new UnauthorizedException(
          'GitHub token is no longer valid. Please re-connect your GitHub account.',
        );
      case 422:
        throw new BadRequestException(`${context}: ${message}`);
      default:
        this.logger.error(
          `GitHub API error during ${context}: ${status} ${message}`,
        );
        throw err;
    }
  }
}
