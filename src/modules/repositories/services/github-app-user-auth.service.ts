import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { firstValueFrom } from 'rxjs';
import { HttpService } from '@nestjs/axios';
import { Octokit } from '@octokit/rest';
import { GithubUserTokenEntity } from '../entities/github-user-token.entity';
import { GitHubAppInstallationEntity } from '../entities/github-app-installation.entity';
import { RepositoryCredentialEntity } from '../entities/repository-credential.entity';
import { GitProvider } from '../entities/repository.entity';
import { GitHubAuthMethod } from '../enums/github-auth-method.enum';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { GitHubIntegrationConfigService } from './github-integration-config.service';
import { GhcrPatAuditService } from './ghcr-pat-audit.service';
import { GithubAppInstallStateService } from './github-app-install-state.service';
import { CredentialStatus, GhcrPatStatusDto } from '../dto/ghcr-pat.dto';

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  refreshTokenExpiresIn: number | null;
  scope: string | null;
}

export interface StoredToken {
  accessToken: string;
  githubLogin: string;
  githubUserId: string;
  installationId: string | null;
}

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

@Injectable()
export class GithubAppUserAuthService {
  private readonly logger = new Logger(GithubAppUserAuthService.name);

  constructor(
    @InjectRepository(GithubUserTokenEntity)
    private readonly tokenRepo: Repository<GithubUserTokenEntity>,
    @InjectRepository(RepositoryCredentialEntity)
    private readonly credentialRepo: Repository<RepositoryCredentialEntity>,
    @InjectRepository(GitHubAppInstallationEntity)
    private readonly installationRepo: Repository<GitHubAppInstallationEntity>,
    private readonly encryptionService: EncryptionService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly integrationConfig: GitHubIntegrationConfigService,
    private readonly audit: GhcrPatAuditService,
    private readonly stateStore: GithubAppInstallStateService,
  ) {}

  static readonly EXPIRING_SOON_DAYS = 14;

  /**
   * The connect flow for a user, surface-agnostic: if already connected returns
   * `alreadyConnected`, otherwise an `installUrl` to open in a browser. Mirrors the
   * controller's GET /install-url logic so an agent tool can return the same URL the
   * dashboard uses — no OAuth done by the agent, the URL is generated server-side.
   */
  async getConnectFlow(userId: string): Promise<{
    alreadyConnected: boolean;
    login?: string;
    installUrl?: string;
  }> {
    const status = await this.getConnectionStatus(userId);
    if (status.connected && (status.installationsCount ?? 0) > 0) {
      return { alreadyConnected: true, login: status.login };
    }
    const state = this.stateStore.issue(userId);
    const installUrl = status.connected
      ? await this.buildInstallOnlyUrl(state)
      : await this.buildInstallUrl(state);
    return { alreadyConnected: false, installUrl };
  }

  /**
   * Build the GitHub URL the user should be redirected to in order to connect
   * the Flui GitHub App. Uses the OAuth authorize endpoint
   * (`/login/oauth/authorize`) so the callback always fires regardless of
   * whether the App is already installed on the user's account — fixing the
   * idempotency hole of `/apps/<slug>/installations/new` which lands on the
   * configure page (no callback) when the App is already installed.
   */
  async buildInstallUrl(state: string): Promise<string> {
    const clientId = await this.integrationConfig.getClientId();
    if (!clientId) {
      throw new BadRequestException(
        'GitHub App client_id is not configured. Set GITHUB_APP_CLIENT_ID (or GITHUB_CLIENT_ID) in the API env, or POST /api/v1/repositories/github/setup/github-app with clientId. Enable "Request user authorization (OAuth) during installation" on the App.',
      );
    }
    const callbackUrl = await this.integrationConfig.getCallbackUrl();
    if (!callbackUrl) {
      throw new BadRequestException(
        'GitHub App callback URL is not configured. Set GITHUB_APP_CALLBACK_URL (or GITHUB_OAUTH_CALLBACK_URL) in the API env — e.g. http://localhost:3000/api/v1/repositories/github-app/user-callback — or POST /api/v1/repositories/github/setup/github-app with callbackUrl. The same URL must be registered on the GitHub App.',
      );
    }
    const params = new URLSearchParams({
      client_id: clientId,
      state,
      redirect_uri: callbackUrl,
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  /**
   * Build the install-only URL — used when the OAuth flow completed but the
   * user has no GitHub App installation yet. We send them here as a second
   * leg to install the App on their account/org.
   */
  async buildInstallOnlyUrl(state: string): Promise<string> {
    const raw = await this.integrationConfig.getAppSlug();
    if (!raw) {
      throw new BadRequestException(
        'GitHub App is not configured (appSlug missing)',
      );
    }
    const slug = raw
      .replace(/.*\/apps\//, '')
      .replace(/\/.*$/, '')
      .trim();
    if (!slug) {
      throw new BadRequestException(
        `Could not derive a GitHub App slug from "${raw}"`,
      );
    }
    return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
  }

  /**
   * Exchange the OAuth `code` returned in the callback for an access token
   * (and optional refresh token when "Expire user tokens" is enabled).
   */
  async exchangeCode(code: string): Promise<ExchangedTokens> {
    const clientId = await this.integrationConfig.getClientId();
    const clientSecret = await this.integrationConfig.getClientSecret();
    if (!clientId || !clientSecret) {
      throw new BadRequestException(
        'GitHub App client_id/client_secret not configured — enable "Request user authorization (OAuth) during installation" on the App and save the client secret via /github/setup/github-app',
      );
    }

    const response = await firstValueFrom(
      this.httpService.post(
        GITHUB_TOKEN_URL,
        {
          client_id: clientId,
          client_secret: clientSecret,
          code,
        },
        {
          headers: { Accept: 'application/json' },
        },
      ),
    );

    const data = response.data;
    if (!data?.access_token) {
      const err = data?.error_description || data?.error || 'unknown';
      throw new BadRequestException(
        `GitHub rejected the code exchange: ${err}`,
      );
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : null,
      refreshTokenExpiresIn:
        typeof data.refresh_token_expires_in === 'number'
          ? data.refresh_token_expires_in
          : null,
      scope: data.scope ?? null,
    };
  }

  /**
   * Save or update the user's U2S token. Looks up the GitHub user via the
   * freshly exchanged token to persist login+id alongside. When
   * `installationId` is not provided by the callback (OAuth-only flow), the
   * App installations accessible to the user are discovered and the first one
   * is persisted.
   */
  async saveToken(
    fluiUserId: string,
    tokens: ExchangedTokens,
    installationId: string | null,
  ): Promise<StoredToken> {
    const octokit = new Octokit({ auth: tokens.accessToken });
    const { data: ghUser } = await octokit.users.getAuthenticated();

    let resolvedInstallationId = installationId;
    if (!resolvedInstallationId) {
      const discovered = await this.discoverInstallation(
        octokit,
        fluiUserId,
        ghUser.login,
      );
      if (discovered) {
        resolvedInstallationId = String(discovered);
      }
    }

    const now = Date.now();
    const expiresAt = tokens.expiresIn
      ? new Date(now + tokens.expiresIn * 1000)
      : null;
    const refreshTokenExpiresAt = tokens.refreshTokenExpiresIn
      ? new Date(now + tokens.refreshTokenExpiresIn * 1000)
      : null;

    const existing = await this.tokenRepo.findOne({ where: { fluiUserId } });

    const payload: Partial<GithubUserTokenEntity> = {
      fluiUserId,
      githubUserId: String(ghUser.id),
      githubLogin: ghUser.login,
      installationId: resolvedInstallationId,
      accessTokenEncrypted: this.encryptionService.encrypt(tokens.accessToken),
      refreshTokenEncrypted: tokens.refreshToken
        ? this.encryptionService.encrypt(tokens.refreshToken)
        : null,
      expiresAt,
      refreshTokenExpiresAt,
      scopes: tokens.scope,
    };

    const saved = existing
      ? await this.tokenRepo.save({ ...existing, ...payload })
      : await this.tokenRepo.save(this.tokenRepo.create(payload));

    this.logger.log(
      `Saved GitHub user token for fluiUserId=${fluiUserId} login=${ghUser.login} installation=${resolvedInstallationId ?? 'none'}`,
    );

    return {
      accessToken: tokens.accessToken,
      githubLogin: saved.githubLogin,
      githubUserId: saved.githubUserId,
      installationId: saved.installationId,
    };
  }

  /**
   * Returns the user's current connection status. Used by the install-url
   * endpoint to short-circuit the browser flow when the user is already
   * connected to GitHub with a valid token.
   *
   * Verifies the stored token against GitHub (one call to `/user`) so that
   * revoked / expired tokens are not reported as connected.
   */
  async getConnectionStatus(fluiUserId: string): Promise<{
    connected: boolean;
    login?: string;
    installationId?: string | null;
    installationsCount?: number;
  }> {
    const stored = await this.getValidToken(fluiUserId);
    if (!stored) return { connected: false };
    let octokit: Octokit;
    try {
      octokit = new Octokit({ auth: stored.accessToken });
      await octokit.users.getAuthenticated();
    } catch {
      return { connected: false };
    }
    // Counting every row said "you already have an installation" to a user who
    // had none of their own, so the install prompt never appeared and the
    // resolver later refused the owner they never installed on.
    const installationsCount = await this.countReachableInstallations(
      fluiUserId,
      octokit,
    );
    return {
      connected: true,
      login: stored.githubLogin,
      installationId: stored.installationId,
      installationsCount,
    };
  }

  private async countReachableInstallations(
    fluiUserId: string,
    octokit: Octokit,
  ): Promise<number> {
    try {
      const { data } = await octokit.apps.listInstallationsForAuthenticatedUser(
        { per_page: 100 },
      );
      return (data.installations ?? []).length;
    } catch (err) {
      this.logger.warn(
        `Could not count GitHub App installations for user ${fluiUserId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return this.installationRepo.count({ where: { userId: fluiUserId } });
    }
  }

  private async discoverInstallation(
    octokit: Octokit,
    fluiUserId: string,
    login: string,
  ): Promise<number | null> {
    const installations = await this.persistAccessibleInstallations(
      octokit,
      fluiUserId,
      login,
    );
    return installations[0] ?? null;
  }

  /**
   * Re-fetches all GitHub App installations accessible to the user's stored
   * OAuth token and upserts each into the installations table. Use this to
   * pick up installations made outside the OAuth flow (e.g. the admin already
   * authorized the App, then went to GitHub directly to install on a new org).
   * Webhook-less environments rely on this to keep the local installations
   * table in sync.
   */
  async rescanInstallations(
    fluiUserId: string,
  ): Promise<{ count: number; installationIds: number[] }> {
    const stored = await this.getValidToken(fluiUserId);
    if (!stored) {
      throw new BadRequestException(
        'No active GitHub user token. Connect your GitHub account first.',
      );
    }
    const octokit = new Octokit({ auth: stored.accessToken });
    const ids = await this.persistAccessibleInstallations(
      octokit,
      fluiUserId,
      stored.githubLogin,
    );

    if (ids.length > 0 && !stored.installationId) {
      await this.tokenRepo.update(
        { fluiUserId },
        { installationId: String(ids[0]) },
      );
    }
    return { count: ids.length, installationIds: ids };
  }

  private async persistAccessibleInstallations(
    octokit: Octokit,
    fluiUserId: string,
    login: string,
  ): Promise<number[]> {
    try {
      const { data } =
        await octokit.apps.listInstallationsForAuthenticatedUser();
      const found = data.installations ?? [];
      const persistedIds: number[] = [];
      for (const inst of found) {
        const accountLogin =
          (inst.account as { login?: string })?.login?.toLowerCase() ??
          login.toLowerCase();
        const accountType =
          ((inst.account as { type?: string })?.type as
            | 'User'
            | 'Organization') ?? 'User';
        const existing = await this.installationRepo.findOne({
          where: { installationId: inst.id },
        });
        if (existing) {
          await this.installationRepo.save({
            ...existing,
            accountLogin,
            accountType,
            userId: fluiUserId,
            repositorySelection: inst.repository_selection ?? 'all',
          });
        } else {
          await this.installationRepo.save(
            this.installationRepo.create({
              installationId: inst.id,
              accountLogin,
              accountType,
              userId: fluiUserId,
              repositorySelection: inst.repository_selection ?? 'all',
            }),
          );
          this.logger.log(
            `Discovered GitHub App installation ${inst.id} for user ${fluiUserId} (account=${accountLogin})`,
          );
        }
        persistedIds.push(inst.id);
      }
      return persistedIds;
    } catch (err) {
      this.logger.warn(
        `Failed to list GitHub App installations for user ${fluiUserId}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Returns the decrypted access token for a user if still valid.
   *
   * - If the token does not expire (no expiresAt), returns it directly.
   * - If expires within 60s and a refresh_token is available, refreshes it.
   * - If expired and no refresh possible, returns null (caller must re-auth).
   */
  async getValidToken(fluiUserId: string): Promise<StoredToken | null> {
    const entity = await this.tokenRepo.findOne({ where: { fluiUserId } });
    if (!entity) return null;

    const aboutToExpire =
      entity.expiresAt && entity.expiresAt.getTime() - Date.now() < 60_000;

    if (aboutToExpire) {
      if (!entity.refreshTokenEncrypted) {
        this.logger.warn(
          `User token for ${fluiUserId} is expired/expiring but no refresh_token is stored`,
        );
        return null;
      }
      return this.refresh(entity);
    }

    return {
      accessToken: this.encryptionService.decrypt(entity.accessTokenEncrypted),
      githubLogin: entity.githubLogin,
      githubUserId: entity.githubUserId,
      installationId: entity.installationId,
    };
  }

  /**
   * Save a classic Personal Access Token with `read:packages`/`write:packages`
   * for the user. Needed because GitHub App tokens (S2S and U2S) cannot
   * currently read user/org-owned container packages — PAT is the only
   * GitHub-supported path outside of GitHub Actions.
   *
   * Validates the token before saving by calling `GET /user` and inspecting
   * the `x-oauth-scopes` response header.
   */
  async saveGhcrPat(
    fluiUserId: string,
    pat: string,
    expiresAt: Date,
  ): Promise<GhcrPatStatusDto> {
    this.assertExpiresAtInFuture(expiresAt);

    const { user, scopes } = await this.verifyPatAgainstGitHub(pat);

    const existing = await this.findActivePat(fluiUserId);
    const isCreate = !existing;

    const now = new Date();
    const payload: Partial<RepositoryCredentialEntity> = {
      userId: fluiUserId,
      provider: GitProvider.GITHUB,
      credentialType: GitHubAuthMethod.PAT,
      accessTokenEncrypted: this.encryptionService.encrypt(pat),
      scope: scopes.join(','),
      githubUsername: user.login,
      githubUserId: String(user.id),
      isActive: true,
      expiresAt,
      lastRotatedAt: now,
      lastVerifiedAt: now,
      lastVerificationStatus: 'OK',
    };

    const saved = existing
      ? await this.credentialRepo.save({ ...existing, ...payload })
      : await this.credentialRepo.save(this.credentialRepo.create(payload));

    this.logger.log(
      `Saved GHCR PAT for fluiUserId=${fluiUserId} login=${user.login} scopes=${scopes.join(',')} expiresAt=${expiresAt.toISOString()}`,
    );

    this.audit.emit({
      type: isCreate ? 'ghcr_pat.created' : 'ghcr_pat.rotated',
      userId: fluiUserId,
      scopes,
      expiresAt: expiresAt.toISOString(),
      previousExpiresAt: existing?.expiresAt
        ? existing.expiresAt.toISOString()
        : null,
      newExpiresAt: expiresAt.toISOString(),
    });

    return this.toStatusDto(saved);
  }

  async rotateGhcrPat(
    fluiUserId: string,
    pat: string,
    expiresAt: Date,
  ): Promise<GhcrPatStatusDto> {
    const existing = await this.findActivePat(fluiUserId);
    if (!existing) {
      throw new NotFoundException(
        'No GHCR PAT configured — use POST /repositories/github-app/packages-pat first',
      );
    }
    this.assertExpiresAtInFuture(expiresAt);

    const { user, scopes } = await this.verifyPatAgainstGitHub(pat);
    const previousExpiresAt = existing.expiresAt
      ? existing.expiresAt.toISOString()
      : null;
    const now = new Date();

    const updated = await this.credentialRepo.save({
      ...existing,
      accessTokenEncrypted: this.encryptionService.encrypt(pat),
      scope: scopes.join(','),
      githubUsername: user.login,
      githubUserId: String(user.id),
      isActive: true,
      expiresAt,
      lastRotatedAt: now,
      lastVerifiedAt: now,
      lastVerificationStatus: 'OK',
    });

    this.audit.emit({
      type: 'ghcr_pat.rotated',
      userId: fluiUserId,
      scopes,
      previousExpiresAt,
      newExpiresAt: expiresAt.toISOString(),
    });

    return this.toStatusDto(updated);
  }

  async updateGhcrPatExpiry(
    fluiUserId: string,
    expiresAt: Date,
  ): Promise<GhcrPatStatusDto> {
    const existing = await this.findActivePat(fluiUserId);
    if (!existing) {
      throw new NotFoundException('No GHCR PAT configured');
    }
    this.assertExpiresAtInFuture(expiresAt);

    const previousExpiresAt = existing.expiresAt
      ? existing.expiresAt.toISOString()
      : null;
    const updated = await this.credentialRepo.save({
      ...existing,
      expiresAt,
    });

    this.audit.emit({
      type: 'ghcr_pat.expiry_updated',
      userId: fluiUserId,
      previousExpiresAt,
      newExpiresAt: expiresAt.toISOString(),
    });

    return this.toStatusDto(updated);
  }

  async getGhcrPatStatus(fluiUserId: string): Promise<GhcrPatStatusDto> {
    const existing = await this.findActivePat(fluiUserId);
    if (!existing)
      return { configured: false, status: CredentialStatus.MISSING };
    return this.toStatusDto(existing);
  }

  async deleteGhcrPat(fluiUserId: string): Promise<void> {
    const existing = await this.findActivePat(fluiUserId);
    await this.credentialRepo.update(
      {
        userId: fluiUserId,
        provider: GitProvider.GITHUB,
        credentialType: GitHubAuthMethod.PAT,
      },
      { isActive: false, revokedAt: new Date() },
    );
    if (existing) {
      this.audit.emit({ type: 'ghcr_pat.deleted', userId: fluiUserId });
    }
  }

  /**
   * Calls GitHub /user with the stored PAT and updates verification fields.
   * Used by the daily background job; safe to call ad-hoc.
   */
  async verifyStoredPat(fluiUserId: string): Promise<GhcrPatStatusDto | null> {
    const existing = await this.findActivePat(fluiUserId);
    if (!existing) return null;

    const pat = this.encryptionService.decrypt(existing.accessTokenEncrypted);
    let status: 'OK' | 'INVALID' | 'SCOPE_MISSING';
    let reason: string | undefined;
    try {
      await this.verifyPatAgainstGitHub(pat);
      status = 'OK';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      status = msg.includes('missing required scope')
        ? 'SCOPE_MISSING'
        : 'INVALID';
      reason = msg;
    }

    const updated = await this.credentialRepo.save({
      ...existing,
      lastVerifiedAt: new Date(),
      lastVerificationStatus: status,
    });

    if (status !== 'OK') {
      this.audit.emit({
        type: 'ghcr_pat.verification_failed',
        userId: fluiUserId,
        reason,
      });
    }

    return this.toStatusDto(updated);
  }

  /**
   * Returns the user's active GHCR PAT in plaintext, or null if not configured.
   * Use for GHCR REST API calls that the GitHub App token cannot service
   * (listing/deleting container package versions on user/org-owned packages).
   */
  async getDecryptedGhcrPat(fluiUserId: string): Promise<string | null> {
    const existing = await this.findActivePat(fluiUserId);
    if (!existing) return null;
    return this.encryptionService.decrypt(existing.accessTokenEncrypted);
  }

  async listActiveGhcrPats(): Promise<RepositoryCredentialEntity[]> {
    return this.credentialRepo.find({
      where: {
        provider: GitProvider.GITHUB,
        credentialType: GitHubAuthMethod.PAT,
        isActive: true,
      },
    });
  }

  private async findActivePat(
    fluiUserId: string,
  ): Promise<RepositoryCredentialEntity | null> {
    return this.credentialRepo.findOne({
      where: {
        userId: fluiUserId,
        provider: GitProvider.GITHUB,
        credentialType: GitHubAuthMethod.PAT,
        isActive: true,
      },
    });
  }

  private assertExpiresAtInFuture(expiresAt: Date): void {
    const minFuture = Date.now() + 24 * 60 * 60 * 1000;
    if (
      !(expiresAt instanceof Date) ||
      Number.isNaN(expiresAt.getTime()) ||
      expiresAt.getTime() < minFuture
    ) {
      throw new BadRequestException(
        'expiresAt must be at least 1 day in the future',
      );
    }
  }

  private async verifyPatAgainstGitHub(pat: string): Promise<{
    user: { login: string; id: number };
    scopes: string[];
  }> {
    if (!pat?.trim()) {
      throw new BadRequestException('PAT is required');
    }

    const response = await firstValueFrom(
      this.httpService.get('https://api.github.com/user', {
        headers: {
          Authorization: `token ${pat}`,
          Accept: 'application/vnd.github+json',
        },
        validateStatus: () => true,
      }),
    );

    if (response.status !== 200) {
      const msg =
        (response.data as { message?: string })?.message ??
        `GitHub responded ${response.status}`;
      throw new BadRequestException(`Invalid GitHub PAT: ${msg}`);
    }

    const scopeHeader =
      (response.headers['x-oauth-scopes'] as string | undefined) ?? '';
    const scopes = scopeHeader
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (
      !scopes.includes('read:packages') &&
      !scopes.includes('write:packages')
    ) {
      throw new BadRequestException(
        `PAT is missing required scope read:packages (granted scopes: ${scopes.join(', ') || 'none'})`,
      );
    }

    return {
      user: response.data as { login: string; id: number },
      scopes,
    };
  }

  private toStatusDto(entity: RepositoryCredentialEntity): GhcrPatStatusDto {
    const scopes =
      entity.scope
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    const { status, daysUntilExpiry } = this.computeStatus(entity);
    return {
      configured: true,
      status,
      expiresAt: entity.expiresAt ?? null,
      daysUntilExpiry,
      lastRotatedAt: entity.lastRotatedAt ?? null,
      lastVerifiedAt: entity.lastVerifiedAt ?? null,
      githubLogin: entity.githubUsername,
      scopes,
    };
  }

  private computeStatus(entity: RepositoryCredentialEntity): {
    status: CredentialStatus;
    daysUntilExpiry: number | null;
  } {
    if (
      entity.lastVerificationStatus === 'INVALID' ||
      entity.lastVerificationStatus === 'SCOPE_MISSING'
    ) {
      return { status: CredentialStatus.INVALID, daysUntilExpiry: null };
    }
    if (!entity.expiresAt) {
      return { status: CredentialStatus.UNKNOWN_EXPIRY, daysUntilExpiry: null };
    }
    const ms = entity.expiresAt.getTime() - Date.now();
    const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
    if (days <= 0)
      return { status: CredentialStatus.EXPIRED, daysUntilExpiry: days };
    if (days <= GithubAppUserAuthService.EXPIRING_SOON_DAYS) {
      return { status: CredentialStatus.EXPIRING_SOON, daysUntilExpiry: days };
    }
    return { status: CredentialStatus.VALID, daysUntilExpiry: days };
  }

  /**
   * Refresh an expiring access token using the stored refresh_token.
   */
  private async refresh(entity: GithubUserTokenEntity): Promise<StoredToken> {
    const clientId = await this.integrationConfig.getClientId();
    const clientSecret = await this.integrationConfig.getClientSecret();
    if (!clientId || !clientSecret || !entity.refreshTokenEncrypted) {
      throw new NotFoundException(
        'Cannot refresh token: missing client credentials or refresh_token',
      );
    }
    const refreshToken = this.encryptionService.decrypt(
      entity.refreshTokenEncrypted,
    );

    const response = await firstValueFrom(
      this.httpService.post(
        GITHUB_TOKEN_URL,
        {
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        },
        { headers: { Accept: 'application/json' } },
      ),
    );
    const data = response.data;
    if (!data?.access_token) {
      throw new BadRequestException(
        `GitHub rejected the refresh: ${data?.error_description || data?.error || 'unknown'}`,
      );
    }

    const now = Date.now();
    entity.accessTokenEncrypted = this.encryptionService.encrypt(
      data.access_token,
    );
    entity.refreshTokenEncrypted = data.refresh_token
      ? this.encryptionService.encrypt(data.refresh_token)
      : entity.refreshTokenEncrypted;
    entity.expiresAt = data.expires_in
      ? new Date(now + Number(data.expires_in) * 1000)
      : null;
    entity.refreshTokenExpiresAt = data.refresh_token_expires_in
      ? new Date(now + Number(data.refresh_token_expires_in) * 1000)
      : entity.refreshTokenExpiresAt;
    const saved = await this.tokenRepo.save(entity);

    this.logger.log(`Refreshed U2S token for fluiUserId=${entity.fluiUserId}`);

    return {
      accessToken: data.access_token,
      githubLogin: saved.githubLogin,
      githubUserId: saved.githubUserId,
      installationId: saved.installationId,
    };
  }
}
