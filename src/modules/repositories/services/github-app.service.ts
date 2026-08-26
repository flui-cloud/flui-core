import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { GitHubIntegrationConfigService } from './github-integration-config.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { GitHubAppInstallationEntity } from '../entities/github-app-installation.entity';
import { GitHubAuthMethod } from '../enums/github-auth-method.enum';
import { GitHubInstallationAccessService } from './github-installation-access.service';

interface CachedToken {
  token: string;
  expiresAt: Date;
}

@Injectable()
export class GitHubAppService {
  private readonly logger = new Logger(GitHubAppService.name);
  private readonly tokenCache = new Map<number, CachedToken>();

  constructor(
    private readonly integrationConfig: GitHubIntegrationConfigService,
    private readonly encryptionService: EncryptionService,
    @InjectRepository(GitHubAppInstallationEntity)
    private readonly installationRepo: Repository<GitHubAppInstallationEntity>,
    private readonly installationAccess: GitHubInstallationAccessService,
  ) {}

  async isEnabled(): Promise<boolean> {
    const config = await this.integrationConfig.getConfig();
    return (
      config?.authMethod === GitHubAuthMethod.GITHUB_APP && config?.isConfigured
    );
  }

  async getInstallationOctokit(
    userId: string,
    owner: string,
  ): Promise<Octokit> {
    const token = await this.getInstallationToken(userId, owner);
    return new Octokit({ auth: token });
  }

  async getInstallationToken(userId: string, owner: string): Promise<string> {
    const installationId = await this.resolveInstallationId(userId, owner);
    return this.getOrRefreshToken(installationId);
  }

  /**
   * An installation token is minted only for a caller GitHub itself places on
   * that installation. An owner the caller does not reach is reported as not
   * installed — the same answer an unknown account gets, so the refusal never
   * confirms that some other tenant onboarded that account here.
   */
  async resolveInstallationId(userId: string, owner: string): Promise<number> {
    const installation = await this.installationAccess.findReachableByOwner(
      userId,
      owner,
    );
    if (!installation) {
      throw new NotFoundException(
        `GitHub App is not installed for account "${owner}". ` +
          `Please install the app at ${await this.getInstallUrl()}`,
      );
    }
    return installation.installationId;
  }

  /** Instance-wide, for the admin routes only. Never for token resolution. */
  async listInstallations(): Promise<GitHubAppInstallationEntity[]> {
    return this.installationRepo.find({ order: { createdAt: 'DESC' } });
  }

  /** The installations this user reaches, as GitHub sees it. */
  async listReachableInstallations(
    userId: string,
  ): Promise<GitHubAppInstallationEntity[]> {
    return this.installationAccess.listReachable(userId);
  }

  // ── Installation lifecycle (webhook handlers) ──

  /**
   * `fluiUserId` is the user the installation was discovered *for*. The webhook
   * has no such user — it only knows who clicked Install on GitHub — and passes
   * nothing: the row is written unattributed and the OAuth discovery attributes
   * it when that user connects.
   */
  async handleInstallationCreated(
    payload: any,
    fluiUserId?: string | null,
  ): Promise<GitHubAppInstallationEntity> {
    const installation = payload.installation;
    const accountLogin = installation.account.login.toLowerCase();

    const existing = await this.installationRepo.findOne({
      where: { installationId: installation.id },
    });
    if (existing) {
      this.logger.log(
        `Installation ${installation.id} already tracked for ${accountLogin}`,
      );
      return existing;
    }

    const entity = this.installationRepo.create({
      installationId: installation.id,
      accountLogin,
      accountType: installation.account.type as 'User' | 'Organization',
      userId: fluiUserId ?? null,
      installedByLogin: payload.sender?.login ?? null,
      repositorySelection: installation.repository_selection ?? 'all',
    });

    const saved = await this.installationRepo.save(entity);
    this.logger.log(
      `Tracked GitHub App installation ${installation.id} for ${accountLogin} (${installation.account.type})`,
    );
    return saved;
  }

  async handleInstallationDeleted(payload: any): Promise<void> {
    const installationId = payload.installation.id;
    const removed = await this.deleteInstallation(installationId);
    if (!removed) {
      this.logger.warn(
        `Installation ${installationId} not found in DB during deletion`,
      );
    }
  }

  async deleteInstallation(installationId: number): Promise<boolean> {
    const result = await this.installationRepo.delete({ installationId });
    this.tokenCache.delete(installationId);
    if (result.affected && result.affected > 0) {
      this.logger.log(`Removed GitHub App installation ${installationId}`);
      return true;
    }
    return false;
  }

  async handleInstallationSuspended(payload: any): Promise<void> {
    const installationId = payload.installation.id;
    await this.installationRepo.update(
      { installationId },
      { suspendedAt: new Date() },
    );
    this.tokenCache.delete(installationId);
    this.logger.log(`Suspended GitHub App installation ${installationId}`);
  }

  async handleInstallationUnsuspended(payload: any): Promise<void> {
    const installationId = payload.installation.id;
    await this.installationRepo.update(
      { installationId },
      { suspendedAt: null },
    );
    this.logger.log(`Unsuspended GitHub App installation ${installationId}`);
  }

  // ── Private helpers ──

  private async getOrRefreshToken(installationId: number): Promise<string> {
    const cached = this.tokenCache.get(installationId);
    const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000);
    if (cached && cached.expiresAt > fiveMinFromNow) {
      return cached.token;
    }

    const config = await this.integrationConfig.getConfig();
    if (!config?.appId || !config?.privateKeyEncrypted) {
      throw new NotFoundException('GitHub App credentials are not configured');
    }

    const appId = config.appId;
    const privateKey = this.encryptionService.decrypt(
      config.privateKeyEncrypted,
    );

    const auth = createAppAuth({ appId, privateKey });
    const result = await auth({
      type: 'installation',
      installationId,
    });

    const expiresAt = new Date(
      (result as any).expiresAt ?? Date.now() + 55 * 60 * 1000,
    );
    this.tokenCache.set(installationId, { token: result.token, expiresAt });

    this.logger.debug(
      `Refreshed installation token for ${installationId}, expires at ${expiresAt.toISOString()}`,
    );
    return result.token;
  }

  /** Where a caller with no reachable installation is sent. */
  async getInstallUrl(): Promise<string> {
    return `https://github.com/apps/${await this.getAppSlug()}/installations/new`;
  }

  private async getAppSlug(): Promise<string> {
    const config = await this.integrationConfig.getConfig();
    return config?.appSlug ?? 'flui-cloud';
  }
}
