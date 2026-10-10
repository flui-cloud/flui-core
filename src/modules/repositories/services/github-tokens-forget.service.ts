import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { RepositoryCredentialEntity } from '../entities/repository-credential.entity';
import { RepositoryEntity } from '../entities/repository.entity';
import { GithubUserTokenEntity } from '../entities/github-user-token.entity';
import { GitHubAppInstallationEntity } from '../entities/github-app-installation.entity';
import { GitHubAppService } from './github-app.service';
import { GitHubInstallationAccessService } from './github-installation-access.service';

/**
 * Every GitHub token Flui holds for one person, removed together.
 *
 * A connected repository keeps its own copy of the token beside the
 * credential, so revoking the credential alone would leave it readable.
 */
@Injectable()
export class GitHubTokensForgetService {
  private readonly logger = new Logger(GitHubTokensForgetService.name);

  constructor(
    @InjectRepository(RepositoryCredentialEntity)
    private readonly credentials: Repository<RepositoryCredentialEntity>,
    @InjectRepository(RepositoryEntity)
    private readonly repositories: Repository<RepositoryEntity>,
    @InjectRepository(GithubUserTokenEntity)
    private readonly userTokens: Repository<GithubUserTokenEntity>,
    @InjectRepository(GitHubAppInstallationEntity)
    private readonly installations: Repository<GitHubAppInstallationEntity>,
    private readonly githubApp: GitHubAppService,
    private readonly access: GitHubInstallationAccessService,
  ) {}

  async forget(userId: string): Promise<number> {
    const uninstalled = await this.leaveTheirAccount(userId);
    const removed = await Promise.all([
      this.credentials.delete({ userId }),
      this.repositories.delete({ userId }),
      this.userTokens.delete({ fluiUserId: userId }),
    ]);
    return removed.reduce((sum, r) => sum + (r.affected ?? 0), uninstalled);
  }

  /**
   * The App comes off the person's own GitHub account — as GitHub lists it to
   * their token — unless another Flui user signs in as that same account. An
   * organisation's installation stays: other people may build through it.
   * Whatever was attributed to this person stops being.
   */
  private async leaveTheirAccount(userId: string): Promise<number> {
    await this.installations.update({ userId }, { userId: null });
    const token = await this.userTokens.findOne({
      where: { fluiUserId: userId },
    });
    if (!token?.githubLogin) return 0;
    const shared = await this.userTokens.count({
      where: { githubLogin: token.githubLogin, fluiUserId: Not(userId) },
    });
    if (shared > 0) return 0;

    let own: number[] = [];
    try {
      own = await this.access.ownAccountInstallationIds(userId);
    } catch (error) {
      this.logger.warn(
        `Could not ask GitHub where ${token.githubLogin} installed Flui: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    let uninstalled = 0;
    for (const installationId of own) {
      try {
        await this.githubApp.uninstall(installationId);
        uninstalled += 1;
      } catch (error) {
        this.logger.warn(
          `Flui is still installed on ${token.githubLogin}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return uninstalled;
  }
}
