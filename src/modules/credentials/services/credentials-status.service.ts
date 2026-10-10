import { Injectable, Logger, Optional } from '@nestjs/common';
import { GithubAppUserAuthService } from '../../repositories/services/github-app-user-auth.service';
import { GitHubIntegrationConfigService } from '../../repositories/services/github-integration-config.service';
import { ManagementService } from '../../management/services/management.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GithubUserTokenEntity } from '../../repositories/entities/github-user-token.entity';
import {
  CredentialKind,
  CredentialStatus,
  CredentialsStatusItemDto,
  CredentialsStatusResponseDto,
} from '../../repositories/dto/ghcr-pat.dto';
import { credentialsVersion } from '../credentials-version';
import { GitHubAuthMethod } from '../../repositories/enums/github-auth-method.enum';
import { FluiRegistryPublisherService } from '../../flui-registry/services/flui-registry-publisher.service';

const REPOSITORIES_PATH = '/apps/repositories';
const GITHUB_SETUP_PATH = '/apps/repositories/github-setup';
const STATUS_PRIORITY: Record<CredentialStatus, number> = {
  [CredentialStatus.VALID]: 0,
  [CredentialStatus.UNKNOWN_EXPIRY]: 0,
  [CredentialStatus.EXPIRING_SOON]: 2,
  [CredentialStatus.MISSING]: 3,
  [CredentialStatus.INVALID]: 4,
  [CredentialStatus.EXPIRED]: 5,
};
const EXPIRING_SOON_DAYS = 14;

@Injectable()
export class CredentialsStatusService {
  private readonly logger = new Logger(CredentialsStatusService.name);
  private readonly cache = new Map<
    string,
    { ts: number; version: number; data: CredentialsStatusResponseDto }
  >();
  /**
   * A save marks this copy's cache stale at once; another copy of the API only
   * learns of it when its entry expires, so the entry stays short.
   */
  private readonly cacheTtlMs = 30 * 1000;

  constructor(
    private readonly userAuth: GithubAppUserAuthService,
    private readonly managementService: ManagementService,
    private readonly integrationConfig: GitHubIntegrationConfigService,
    @InjectRepository(GithubUserTokenEntity)
    private readonly githubTokenRepo: Repository<GithubUserTokenEntity>,
    @Optional() private readonly registry?: FluiRegistryPublisherService,
  ) {}

  async getStatus(userId: string): Promise<CredentialsStatusResponseDto> {
    const version = credentialsVersion();
    const cached = this.cache.get(userId);
    if (
      cached?.version === version &&
      Date.now() - cached.ts < this.cacheTtlMs
    ) {
      return cached.data;
    }

    const items: CredentialsStatusItemDto[] = [];

    const config = await this.integrationConfig.getConfig();
    // With tokens, the person's one GitHub token is both the connection and
    // the registry token, so it is reported once, as the GitHub connection.
    // On an instance that runs its own registry no GHCR token is needed at all.
    const githubItems =
      config?.authMethod === GitHubAuthMethod.PAT
        ? [await this.buildGithubPatItem(userId)]
        : [
            await this.buildGithubAppItem(userId, config !== null),
            ...(this.registry?.host()
              ? []
              : [await this.buildGhcrPatItem(userId)]),
          ];
    items.push(...githubItems, ...(await this.buildProviderItems()));

    const overallStatus = items.reduce<CredentialStatus>(
      (worst, item) =>
        STATUS_PRIORITY[item.status] > STATUS_PRIORITY[worst]
          ? item.status
          : worst,
      CredentialStatus.VALID,
    );

    const response: CredentialsStatusResponseDto = { overallStatus, items };
    this.cache.set(userId, { ts: Date.now(), version, data: response });
    return response;
  }

  private async buildGithubAppItem(
    userId: string,
    instanceConfigured: boolean,
  ): Promise<CredentialsStatusItemDto> {
    const token = await this.githubTokenRepo.findOne({
      where: { fluiUserId: userId },
    });
    const actionUrl = instanceConfigured
      ? REPOSITORIES_PATH
      : GITHUB_SETUP_PATH;
    return {
      kind: CredentialKind.GITHUB_APP,
      label: instanceConfigured ? 'Your GitHub account' : 'GitHub App',
      status: token ? CredentialStatus.VALID : CredentialStatus.MISSING,
      expiresAt: null,
      daysUntilExpiry: null,
      actionUrl,
    };
  }

  private async buildGithubPatItem(
    userId: string,
  ): Promise<CredentialsStatusItemDto> {
    const status = await this.userAuth.getGhcrPatStatus(userId);
    return {
      kind: CredentialKind.GITHUB_PAT,
      label: 'Your GitHub token',
      status: status.status ?? CredentialStatus.MISSING,
      expiresAt: status.expiresAt ?? null,
      daysUntilExpiry: status.daysUntilExpiry ?? null,
      actionUrl: REPOSITORIES_PATH,
    };
  }

  private async buildGhcrPatItem(
    userId: string,
  ): Promise<CredentialsStatusItemDto> {
    const status = await this.userAuth.getGhcrPatStatus(userId);
    return {
      kind: CredentialKind.GHCR_PAT,
      label: 'GitHub Container Registry token',
      status: status.status ?? CredentialStatus.MISSING,
      expiresAt: status.expiresAt ?? null,
      daysUntilExpiry: status.daysUntilExpiry ?? null,
      actionUrl: REPOSITORIES_PATH,
    };
  }

  private async buildProviderItems(): Promise<CredentialsStatusItemDto[]> {
    let configs;
    try {
      configs = await this.managementService.getUserProviderConfigurations({
        isActive: true,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to load provider configurations for credentials status: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }

    return configs.map((config) => {
      const expiresAt = config.credentialsExpiresAt ?? null;
      const { status, daysUntilExpiry } = this.computeProviderStatus(expiresAt);
      return {
        kind: CredentialKind.PROVIDER,
        providerId: config.provider,
        label: String(config.provider),
        status,
        expiresAt,
        daysUntilExpiry,
        actionUrl: `/management/providers/${config.provider}`,
      };
    });
  }

  private computeProviderStatus(expiresAt: Date | null): {
    status: CredentialStatus;
    daysUntilExpiry: number | null;
  } {
    if (!expiresAt) {
      return { status: CredentialStatus.VALID, daysUntilExpiry: null };
    }
    const ms = new Date(expiresAt).getTime() - Date.now();
    const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
    if (days <= 0)
      return { status: CredentialStatus.EXPIRED, daysUntilExpiry: days };
    if (days <= EXPIRING_SOON_DAYS) {
      return { status: CredentialStatus.EXPIRING_SOON, daysUntilExpiry: days };
    }
    return { status: CredentialStatus.VALID, daysUntilExpiry: days };
  }

  invalidate(): void {
    this.cache.clear();
  }
}
