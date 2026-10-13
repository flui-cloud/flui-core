import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { GithubAppManifestStateEntity } from '../entities/github-app-manifest-state.entity';

/** A GitHub user or organisation login: letters, digits and single inner hyphens, at most 39. */
export const GITHUB_LOGIN_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function githubAppCreationUrl(organization?: string): string {
  const org = organization?.trim();
  if (!org) return 'https://github.com/settings/apps/new';
  if (!GITHUB_LOGIN_PATTERN.test(org)) {
    throw new BadRequestException(
      `"${org}" is not a GitHub organisation name: use its login as it appears in github.com/<organisation>.`,
    );
  }
  return `https://github.com/organizations/${org}/settings/apps/new`;
}

export interface ConsumedManifestState {
  fluiUserId: string;
  callbackUrl: string;
}

/**
 * Persisted store for GitHub App manifest `state` tokens used to correlate
 * the "Create on GitHub" submission with the manifest-conversion callback.
 * Single-use, auto-evicted after TTL. Backed by the DB so it survives API
 * restarts and works across replicas.
 */
@Injectable()
export class GithubAppManifestStateService {
  private readonly logger = new Logger(GithubAppManifestStateService.name);
  private readonly ttlMs = 10 * 60 * 1000;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(GithubAppManifestStateEntity)
    private readonly stateRepository: Repository<GithubAppManifestStateEntity>,
  ) {
    setInterval(() => {
      void this.evictExpired();
    }, 60_000).unref();
  }

  /**
   * Build the GitHub "create App from manifest" payload + target URL, prefilled with
   * Flui's permissions, events, callback and redirect URLs. The caller (controller or
   * an agent tool) submits it as a form POST to GitHub; on confirm GitHub redirects to
   * our manifest-callback and we persist the App credentials. `publicApiUrl` falls back
   * to the PUBLIC_API_URL env when not passed (the agent path has no request to derive it).
   * With `organization` the App is created as that organisation's, which GitHub answers on
   * the same redirect with the same conversion.
   */
  async buildManifestStart(
    fluiUserId: string,
    opts: {
      name?: string;
      publicApiUrl?: string;
      webhooksEnabled?: boolean;
      publicApp?: boolean;
      organization?: string;
    } = {},
  ): Promise<{
    manifestJson: Record<string, unknown>;
    githubUrl: string;
    state: string;
  }> {
    const raw = opts.publicApiUrl ?? this.config.get<string>('PUBLIC_API_URL');
    if (!raw || !/^https?:\/\//i.test(raw.trim())) {
      throw new BadRequestException(
        'PUBLIC_API_URL is not configured on this instance — set it before generating the GitHub App setup link.',
      );
    }
    const githubUrl = githubAppCreationUrl(opts.organization);
    const base = raw.trim().replace(/\/$/, '');
    const webhooksEnabled = opts.webhooksEnabled ?? false;
    const callbackUrl = `${base}/api/v1/repositories/github-app/user-callback`;
    const state = await this.issue(fluiUserId, callbackUrl);
    const redirectUrl = `${base}/api/v1/repositories/github/setup/github-app/manifest-callback/${state}`;
    const manifestJson: Record<string, unknown> = {
      name: opts.name ?? 'Flui',
      url: base,
      redirect_url: redirectUrl,
      callback_urls: [callbackUrl],
      public: opts.publicApp ?? false,
      request_oauth_on_install: true,
      default_permissions: {
        contents: 'write',
        metadata: 'read',
        actions: 'write',
        workflows: 'write',
        secrets: 'write',
        pull_requests: 'write',
      },
    };
    // GitHub rejects a manifest with a blank hook url or with event subscriptions
    // but no webhook — only declare the webhook (and its events) when it is enabled.
    if (webhooksEnabled) {
      manifestJson.hook_attributes = {
        url: `${base}/api/v1/webhooks/github-app`,
        active: true,
      };
      manifestJson.default_events = ['workflow_run', 'push', 'pull_request'];
    }
    return {
      manifestJson,
      githubUrl,
      state,
    };
  }

  async issue(fluiUserId: string, callbackUrl: string): Promise<string> {
    const state = randomUUID();
    await this.stateRepository.save(
      this.stateRepository.create({
        state,
        fluiUserId,
        callbackUrl,
        expiresAt: new Date(Date.now() + this.ttlMs),
      }),
    );
    return state;
  }

  async consume(state: string): Promise<ConsumedManifestState | null> {
    const entry = await this.stateRepository.findOne({ where: { state } });
    if (!entry) return null;
    await this.stateRepository.delete({ state });
    if (entry.expiresAt.getTime() < Date.now()) return null;
    return {
      fluiUserId: entry.fluiUserId,
      callbackUrl: entry.callbackUrl,
    };
  }

  private async evictExpired(): Promise<void> {
    try {
      const result = await this.stateRepository.delete({
        expiresAt: LessThan(new Date()),
      });
      if (result.affected) {
        this.logger.debug(
          `Evicted ${result.affected} expired manifest state entries`,
        );
      }
    } catch (err) {
      this.logger.warn(`Manifest state eviction failed: ${err.message}`);
    }
  }
}
