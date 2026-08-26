import { Injectable, Logger } from '@nestjs/common';
import { Octokit } from '@octokit/rest';
import { GitHubOAuthService } from './github-oauth.service';
import { GitHubAppService } from './github-app.service';

/**
 * Single decision point for obtaining an authenticated Octokit instance.
 *
 * - When GitHub App is configured: uses installation tokens (server-to-server).
 * - When OAuth/PAT is configured: uses the user's personal token (current behaviour).
 *
 * All services that need to call the GitHub API should inject this resolver
 * instead of calling `GitHubOAuthService.getOctokit()` directly.
 */
@Injectable()
export class GitHubTokenResolverService {
  private readonly logger = new Logger(GitHubTokenResolverService.name);

  constructor(
    private readonly githubOAuthService: GitHubOAuthService,
    private readonly githubAppService: GitHubAppService,
  ) {}

  /**
   * Returns an authenticated Octokit for operations on a specific owner's repos.
   *
   * `userId` binds the credential to the caller in BOTH modes. In App mode the
   * owner comes from a request body, so it is the caller's reach on that
   * installation — not the mere existence of a row — that decides.
   *
   * @param userId  Flui user ID of the caller
   * @param owner   GitHub account (org or user) that owns the repo
   */
  async getOctokit(userId: string, owner: string): Promise<Octokit> {
    if (await this.githubAppService.isEnabled()) {
      return this.githubAppService.getInstallationOctokit(userId, owner);
    }
    return this.githubOAuthService.getOctokit(userId);
  }

  /**
   * Returns a raw access token string (for docker login, repo secrets, etc.).
   */
  async getAccessToken(userId: string, owner: string): Promise<string> {
    if (await this.githubAppService.isEnabled()) {
      return this.githubAppService.getInstallationToken(userId, owner);
    }
    return this.githubOAuthService.getAccessToken(userId);
  }

  /**
   * Asserts that required GitHub capabilities are available.
   * - GitHub App mode: no-op (permissions are set at the app level).
   * - OAuth/PAT mode: delegates to assertRequiredScopes.
   */
  async assertCapability(userId: string, required: string[]): Promise<void> {
    if (await this.githubAppService.isEnabled()) {
      return; // App permissions are granted at installation time
    }
    await this.githubOAuthService.assertRequiredScopes(userId, required);
  }

  /**
   * Whether the GitHub App integration is active.
   */
  async isAppMode(): Promise<boolean> {
    return this.githubAppService.isEnabled();
  }
}
