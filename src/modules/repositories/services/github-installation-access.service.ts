import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Octokit } from '@octokit/rest';
import { GitHubAppInstallationEntity } from '../entities/github-app-installation.entity';
import { GithubAppUserAuthService } from './github-app-user-auth.service';

/**
 * How long a user's set of reachable installation ids is trusted before GitHub
 * is asked again. Importing twenty repositories must cost one round-trip, not
 * twenty; a minute is short enough that an uninstall stops working quickly.
 */
export const INSTALLATION_REACH_TTL_MS = 60_000;

interface CachedReach {
  ids: Set<number>;
  expiresAt: number;
}

/**
 * Answers one question: does this Flui user reach this GitHub App installation?
 *
 * The answer is GitHub's, not ours. An installation on an organization serves
 * everyone GitHub says it serves, which is never the single row that recorded
 * it — so filtering the installations table by `user_id` would refuse the
 * legitimate case. We ask GitHub as the user
 * (`GET /user/installations`, the same call the connect flow already makes)
 * and cache the answer per user.
 *
 * The stored `user_id` is used only as a cached proof: the row was written for
 * that user precisely because GitHub had already listed the installation as
 * theirs. It is never used to widen access, only to skip a round-trip.
 */
@Injectable()
export class GitHubInstallationAccessService {
  private readonly logger = new Logger(GitHubInstallationAccessService.name);
  private readonly reachCache = new Map<string, CachedReach>();

  constructor(
    @InjectRepository(GitHubAppInstallationEntity)
    private readonly installationRepo: Repository<GitHubAppInstallationEntity>,
    private readonly userAuth: GithubAppUserAuthService,
  ) {}

  /**
   * The installation for `owner` that `userId` reaches, or null. Null covers
   * both "no such installation" and "not yours" on purpose: telling the two
   * apart would confirm to a stranger that an account is onboarded here.
   */
  async findReachableByOwner(
    userId: string,
    owner: string,
  ): Promise<GitHubAppInstallationEntity | null> {
    const login = owner?.trim().toLowerCase();
    if (!login) return null;

    const candidates = await this.installationRepo.find({
      where: { accountLogin: login },
      order: { createdAt: 'DESC' },
    });
    for (const candidate of candidates) {
      if (await this.reaches(userId, candidate)) return candidate;
    }
    return null;
  }

  /** Every tracked installation this user reaches, newest first. */
  async listReachable(userId: string): Promise<GitHubAppInstallationEntity[]> {
    const all = await this.installationRepo.find({
      order: { createdAt: 'DESC' },
    });
    const reachable: GitHubAppInstallationEntity[] = [];
    for (const installation of all) {
      if (await this.reaches(userId, installation))
        reachable.push(installation);
    }
    return reachable;
  }

  private async reaches(
    userId: string,
    installation: GitHubAppInstallationEntity,
  ): Promise<boolean> {
    if (!userId) return false;
    if (installation.userId && installation.userId === userId) return true;
    const ids = await this.reachableInstallationIds(userId);
    return ids.has(Number(installation.installationId));
  }

  private async reachableInstallationIds(userId: string): Promise<Set<number>> {
    const cached = this.reachCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.ids;

    const ids = await this.askGitHub(userId);
    this.reachCache.set(userId, {
      ids,
      expiresAt: Date.now() + INSTALLATION_REACH_TTL_MS,
    });
    return ids;
  }

  private async askGitHub(userId: string): Promise<Set<number>> {
    const stored = await this.userAuth.getValidToken(userId);
    if (!stored) return new Set();

    try {
      const octokit = new Octokit({ auth: stored.accessToken });
      const { data } = await octokit.apps.listInstallationsForAuthenticatedUser(
        { per_page: 100 },
      );
      return new Set((data.installations ?? []).map((i) => Number(i.id)));
    } catch (err) {
      this.logger.warn(
        `Could not list GitHub App installations for user ${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return new Set();
    }
  }
}
