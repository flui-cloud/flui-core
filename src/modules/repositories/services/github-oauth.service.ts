import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import { RepositoryCredentialsRepository } from '../repositories/repository-credentials.repository';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { GitProvider } from '../entities/repository.entity';
import { GitHubAuthMethod } from '../enums/github-auth-method.enum';
import { GitHubIntegrationConfigService } from './github-integration-config.service';
import { GitHubAppService } from './github-app.service';
import {
  GitHubOAuthStatusResponseDto,
  ConnectPatResponseDto,
  PublicRepoSearchResultDto,
  PublicRepoBranchDto,
  PatValidationResultDto,
} from '../dto/github-oauth.dto';

@Injectable()
export class GitHubOAuthService {
  private readonly logger = new Logger(GitHubOAuthService.name);
  private readonly oauthScopes = [
    'repo',
    'user:email',
    'admin:repo_hook',
    'write:packages',
    // `read:packages` is required despite `write:packages`: GitHub returns 404
    // on `GET /user/packages` without it (used by deploy `--no-build`).
    'read:packages',
    'delete:packages',
    'workflow',
  ];

  constructor(
    private readonly integrationConfig: GitHubIntegrationConfigService,
    private readonly githubAppService: GitHubAppService,
    private readonly credentialsRepository: RepositoryCredentialsRepository,
    private readonly encryptionService: EncryptionService,
    private readonly configService: ConfigService,
  ) {}

  async connectWithPat(
    userId: string,
    pat: string,
  ): Promise<ConnectPatResponseDto> {
    const config = await this.integrationConfig.getConfig();

    if (!config?.isConfigured) {
      throw new ServiceUnavailableException(
        'GitHub integration not configured. Complete setup first via POST /repositories/github/setup/pat',
      );
    }

    if (config.authMethod !== GitHubAuthMethod.PAT) {
      throw new BadRequestException(
        'GitHub is configured in GitHub App mode. Connect via GET /repositories/github-app/install-url instead.',
      );
    }

    let githubUserId: string;
    let githubUsername: string;

    try {
      const octokit = new Octokit({ auth: pat });
      const { data } = await octokit.users.getAuthenticated();
      githubUserId = data.id.toString();
      githubUsername = data.login;
    } catch {
      throw new BadRequestException(
        'Invalid Personal Access Token. Make sure it has the required scopes: repo, user:email',
      );
    }

    await this.credentialsRepository.revokeAllByProvider(
      userId,
      GitProvider.GITHUB,
    );

    await this.credentialsRepository.create({
      userId,
      provider: GitProvider.GITHUB,
      credentialType: GitHubAuthMethod.PAT,
      accessTokenEncrypted: this.encryptionService.encrypt(pat),
      scope: this.oauthScopes.join(' '),
      tokenType: 'Bearer',
      githubUserId,
      githubUsername,
      isActive: true,
    });

    this.logger.log(
      `GitHub PAT connected for user ${userId} (GitHub: ${githubUsername})`,
    );

    return { connected: true, githubUsername };
  }

  async getActiveCredential(userId: string) {
    const credential = await this.credentialsRepository.findByUserIdAndProvider(
      userId,
      GitProvider.GITHUB,
    );

    if (!credential) {
      throw new NotFoundException(
        'No active GitHub connection found. Please connect your GitHub account.',
      );
    }

    return credential;
  }

  async getStatus(userId: string): Promise<GitHubOAuthStatusResponseDto> {
    // In GitHub App mode, report only installations this user reaches.
    // Reading the table globally used to answer "connected as <someone
    // else's account>" to anyone authenticated.
    if (await this.githubAppService.isEnabled()) {
      const installations =
        await this.githubAppService.listReachableInstallations(userId);
      if (installations.length > 0) {
        return {
          connected: true,
          githubUsername: installations[0].accountLogin,
          connectedAt: installations[0].createdAt,
        };
      }
      return { connected: false };
    }

    const credential = await this.credentialsRepository.findByUserIdAndProvider(
      userId,
      GitProvider.GITHUB,
    );

    if (!credential) {
      return { connected: false };
    }

    return {
      connected: true,
      githubUsername: credential.githubUsername,
      scopes: credential.scope,
      connectedAt: credential.createdAt,
    };
  }

  async revokeAccess(userId: string): Promise<void> {
    const credential = await this.getActiveCredential(userId);
    await this.credentialsRepository.revoke(credential.id);
    this.logger.log(`Deactivated GitHub credential for user ${userId}`);
  }

  async getOctokit(userId: string): Promise<Octokit> {
    const credential = await this.getActiveCredential(userId);
    const accessToken = this.encryptionService.decrypt(
      credential.accessTokenEncrypted,
    );
    return new Octokit({ auth: accessToken });
  }

  async getAccessToken(userId: string): Promise<string> {
    const credential = await this.getActiveCredential(userId);
    return this.encryptionService.decrypt(credential.accessTokenEncrypted);
  }

  /**
   * Returns the OAuth scopes associated with the user's current GitHub token.
   * GitHub includes them in the `x-oauth-scopes` response header on every API call.
   */
  async getTokenScopes(userId: string): Promise<string[]> {
    const octokit = await this.getOctokit(userId);
    const response = await octokit.users.getAuthenticated();
    const scopeHeader =
      (response.headers as Record<string, string>)['x-oauth-scopes'] ?? '';
    return scopeHeader
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * Throws a `BadRequestException` with a re-authorization message if any of
   * the required GitHub OAuth scopes are missing from the user's current token.
   */
  async assertRequiredScopes(
    userId: string,
    required: string[],
  ): Promise<void> {
    const current = await this.getTokenScopes(userId);
    const missing = required.filter((s) => !this.isScopeGranted(s, current));

    if (missing.length > 0) {
      throw new BadRequestException(
        `Your GitHub connection is missing the required permission${missing.length > 1 ? 's' : ''}: ` +
          `[${missing.join(', ')}]. ` +
          `Re-create your Personal Access Token with the missing scopes and reconnect via POST /repositories/github/connect-pat.`,
      );
    }
  }

  // GitHub's scope hierarchy: a parent scope grants its children, but the
  // `x-oauth-scopes` header only reports what the user literally checked.
  // Match the granted set against the hierarchy so we don't flag a scope as
  // missing when a broader one covers it.
  private isScopeGranted(target: string, granted: string[]): boolean {
    if (granted.includes(target)) return true;
    if (target === 'read:packages' && granted.includes('write:packages')) {
      return true;
    }
    if (
      (target === 'read:repo_hook' || target === 'write:repo_hook') &&
      granted.includes('admin:repo_hook')
    ) {
      return true;
    }
    return false;
  }

  async validatePat(token: string): Promise<PatValidationResultDto> {
    if (!token || token.trim().length === 0) {
      return { valid: false, error: 'empty_token' };
    }

    try {
      const octokit = new Octokit({ auth: token });
      const response = await octokit.users.getAuthenticated();
      const scopeHeader =
        (response.headers as Record<string, string>)['x-oauth-scopes'] ?? '';
      const scopes = scopeHeader
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const missingScopes = this.oauthScopes.filter(
        (s) => !this.isScopeGranted(s, scopes),
      );
      return {
        valid: true,
        login: response.data.login,
        githubUserId: response.data.id.toString(),
        scopes,
        missingScopes,
      };
    } catch (error) {
      const status = error?.status;
      if (status === 401) {
        return { valid: false, error: 'invalid_token' };
      }
      if (status === 403 && /sso|saml/i.test(error?.message ?? '')) {
        return { valid: false, error: 'sso_required' };
      }
      this.logger.warn(`PAT validation failed: ${status} ${error?.message}`);
      return {
        valid: false,
        error: 'github_unreachable',
        message: error?.message,
      };
    }
  }

  async testConnection(
    userId: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const octokit = await this.getOctokit(userId);
      await octokit.users.getAuthenticated();
      return { success: true, message: 'GitHub connection is active' };
    } catch (error) {
      this.logger.error(
        `GitHub connection test failed for user ${userId}`,
        error.stack,
      );
      return { success: false, message: 'GitHub connection test failed' };
    }
  }

  /**
   * Search public GitHub repositories. Uses GITHUB_TOKEN env var if set (5000 req/hr),
   * otherwise falls back to unauthenticated requests (60 req/hr).
   */
  async searchPublicRepositories(
    query: string,
    limit: number,
  ): Promise<PublicRepoSearchResultDto[]> {
    const systemToken = this.configService.get<string>('GITHUB_TOKEN');
    const octokit = new Octokit({ auth: systemToken || undefined });

    const { data } = await octokit.search.repos({
      q: query,
      per_page: Math.min(limit, 100),
      sort: 'stars',
      order: 'desc',
    });

    return data.items.map((item) => ({
      name: item.name,
      full_name: item.full_name,
      description: item.description ?? null,
      stars: item.stargazers_count,
      language: item.language ?? null,
      default_branch: item.default_branch,
      clone_url: item.clone_url,
      html_url: item.html_url,
      is_private: false as const,
    }));
  }

  /**
   * List branches of a public GitHub repository.
   * Uses GITHUB_TOKEN env var if set for higher rate limits.
   * @param ownerRepo  owner/repo format (e.g. "vercel/next.js")
   */
  async getPublicRepoBranches(
    ownerRepo: string,
  ): Promise<PublicRepoBranchDto[]> {
    const parts = ownerRepo.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new BadRequestException(
        'repo must be in owner/repo format (e.g. "vercel/next.js")',
      );
    }
    const [owner, repo] = parts;

    const systemToken = this.configService.get<string>('GITHUB_TOKEN');
    const octokit = new Octokit({ auth: systemToken || undefined });

    const { data } = await octokit.repos.listBranches({
      owner,
      repo,
      per_page: 100,
    });

    return data.map((branch) => ({
      name: branch.name,
      sha: branch.commit.sha,
    }));
  }
}
