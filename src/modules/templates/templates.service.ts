import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GitHubOAuthService } from '../repositories/services/github-oauth.service';
import { GitHubTokenResolverService } from '../repositories/services/github-token-resolver.service';
import { GitHubAppService } from '../repositories/services/github-app.service';
import {
  TEMPLATE_REGISTRY,
  TemplateConfig,
  findTemplate,
  listFrameworkVersions,
} from './config/template-registry';
import { UseTemplateDto, UseTemplateResponseDto } from './dto/template.dto';

@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);
  private readonly templateOrg: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly githubOAuthService: GitHubOAuthService,
    private readonly tokenResolver: GitHubTokenResolverService,
    private readonly githubAppService: GitHubAppService,
  ) {
    this.templateOrg = this.configService.get<string>(
      'FLUI_GITHUB_TEMPLATE_ORG',
      'flui-cloud',
    );
  }

  listTemplates(): TemplateConfig[] {
    return TEMPLATE_REGISTRY.map((t) => ({
      ...t,
      repoUrl: `https://github.com/${this.templateOrg}/${t.repo}`,
    }));
  }

  getTemplate(framework: string, version?: string): TemplateConfig {
    const template = findTemplate(framework, version);
    if (!template) {
      const available = listFrameworkVersions(framework);
      if (version && available.length > 0) {
        throw new NotFoundException(
          `Template "${framework}@${version}" not found. Available: ${available.join(', ')}`,
        );
      }
      throw new NotFoundException(`Template "${framework}" not found`);
    }
    return {
      ...template,
      repoUrl: `https://github.com/${this.templateOrg}/${template.repo}`,
    };
  }

  /**
   * Creates a new repository in the user's GitHub account starting from a Flui
   * template repository. Uses GitHub's "Generate from template" API
   * (`POST /repos/{template_owner}/{template_repo}/generate`), which requires
   * the `repo` scope on the user's OAuth token and read access to the template
   * repository.
   */
  async useTemplate(
    userId: string,
    framework: string,
    dto: UseTemplateDto,
  ): Promise<UseTemplateResponseDto> {
    const template = this.getTemplate(framework);

    await this.tokenResolver.assertCapability(userId, ['repo']);

    let targetOwner = dto.owner?.trim();

    if (!targetOwner) {
      if (await this.githubAppService.isEnabled()) {
        // The default owner is picked among the accounts this caller reaches.
        // The first row of the table belongs to whoever onboarded first — an
        // operator, or another tenant — and it travelled from here into the
        // error messages below, which the caller reads.
        const reachable =
          await this.githubAppService.listReachableInstallations(userId);
        if (reachable.length === 0) {
          throw new NotFoundException(
            'GitHub App is not installed for any account you can reach. ' +
              `Install it at ${await this.githubAppService.getInstallUrl()} ` +
              'and retry, or name an "owner" you already have it on.',
          );
        }
        targetOwner = reachable[0].accountLogin;
      } else {
        const credential =
          await this.githubOAuthService.getActiveCredential(userId);
        targetOwner = credential.githubUsername;
      }
    }

    if (!targetOwner) {
      throw new BadRequestException(
        'Unable to determine the target GitHub owner. Please specify "owner" in the request body.',
      );
    }

    const octokit = await this.tokenResolver.getOctokit(userId, targetOwner);

    try {
      const response = await octokit.repos.createUsingTemplate({
        template_owner: this.templateOrg,
        template_repo: template.repo,
        owner: targetOwner,
        name: dto.name,
        description:
          dto.description ??
          `Created from Flui template ${template.displayName}`,
        private: dto.private ?? true,
        include_all_branches: dto.includeAllBranches ?? false,
      });

      const newRepo = response.data;

      this.logger.log(
        `User ${userId} generated repo ${newRepo.full_name} from template ${this.templateOrg}/${template.repo}`,
      );

      // GitHub returns 201 immediately but the repo isn't fully populated yet —
      // the default branch ref doesn't exist for a few seconds. Wait for it so
      // that callers can immediately commit/clone without hitting a 404 race.
      await this.waitForRepoReady(
        octokit,
        newRepo.owner?.login ?? targetOwner,
        newRepo.name,
        newRepo.default_branch ?? 'main',
      );

      return this.toUseTemplateResponse(template, newRepo, targetOwner, false);
    } catch (error: unknown) {
      const status = (error as { status?: number }).status;
      const message =
        (error as { message?: string }).message ?? 'Unknown error';

      if (status === 404) {
        throw new NotFoundException(
          `Template repository "${this.templateOrg}/${template.repo}" not found or not accessible. ` +
            'Make sure the repository exists, is marked as a Template repository on GitHub, ' +
            'and that your GitHub account has read access to it.',
        );
      }

      // 422 from GitHub usually means "name already exists". Treat this as
      // idempotent: if the existing repo was actually generated from the SAME
      // Flui template, return it as success (`alreadyExisted: true`) so the
      // frontend can safely retry the whole flow. Otherwise surface a 409.
      if (status === 422) {
        const existing = await this.tryFetchExistingTemplateRepo(
          octokit,
          targetOwner,
          dto.name,
          template.repo,
        );

        if (existing) {
          this.logger.log(
            `useTemplate retry detected: ${targetOwner}/${dto.name} already exists and matches template ${this.templateOrg}/${template.repo}, returning existing repo`,
          );
          return this.toUseTemplateResponse(
            template,
            existing,
            targetOwner,
            true,
          );
        }

        throw new ConflictException(
          `A repository named "${targetOwner}/${dto.name}" already exists and was not generated from the Flui template "${template.repo}". ` +
            'Pick a different name, or delete the existing repository on GitHub before retrying.',
        );
      }

      if (status === 403) {
        throw new BadRequestException(
          `GitHub denied the request: ${message}. ` +
            `Make sure your GitHub token has the "repo" scope and that you can create repositories under "${targetOwner}".`,
        );
      }

      this.logger.error(
        `Failed to create repo from template for user ${userId}: ${message}`,
      );
      throw new BadRequestException(
        `Failed to generate repository from template: ${message}`,
      );
    }
  }

  /**
   * Polls GitHub until the new repo's default branch ref exists, meaning the
   * template files have been written and the repo is safe to clone/commit to.
   *
   * GitHub's `createUsingTemplate` returns `201` as soon as the repo record
   * is created, but the actual file population happens asynchronously and can
   * take a few seconds. Without this wait, the very next call (typically
   * `git.getRef` from `commitWorkflowOnly`) returns 404.
   *
   * We poll for up to ~15 seconds (10 attempts, 1.5s apart). If the ref still
   * isn't there we log a warning and proceed — the caller will get a clearer
   * error downstream if something is genuinely wrong.
   */
  private async waitForRepoReady(
    octokit: import('@octokit/rest').Octokit,
    owner: string,
    repo: string,
    branch: string,
  ): Promise<void> {
    const maxAttempts = 10;
    const delayMs = 1500;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
        if (attempt > 1) {
          this.logger.log(
            `Repo ${owner}/${repo} ready after ${attempt} attempt(s) (~${attempt * delayMs}ms)`,
          );
        }
        return;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 404) {
          // Any other error (rate limit, auth, …) — give up waiting and let
          // the caller surface the real failure.
          this.logger.warn(
            `Unexpected error while waiting for ${owner}/${repo}@${branch}: status=${status}, ${(error as Error).message}`,
          );
          return;
        }
        if (attempt === maxAttempts) {
          this.logger.warn(
            `Repo ${owner}/${repo}@${branch} still not ready after ${maxAttempts * delayMs}ms — proceeding anyway`,
          );
          return;
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  /**
   * On a retry after a partial failure, the GitHub repo may already exist.
   * Fetch it and verify it was actually generated from the same Flui template
   * (GitHub exposes `template_repository` on the repo metadata when this is
   * the case). Returns the repo on match, `null` otherwise (or on any error,
   * which we swallow because the caller will translate to a 409).
   */
  private async tryFetchExistingTemplateRepo(
    octokit: import('@octokit/rest').Octokit,
    owner: string,
    name: string,
    expectedTemplateRepo: string,
  ): Promise<GitHubRepoLike | null> {
    try {
      const { data } = await octokit.repos.get({ owner, repo: name });

      const templateRepository = (
        data as { template_repository?: { full_name?: string } | null }
      ).template_repository;
      const expectedFullName = `${this.templateOrg}/${expectedTemplateRepo}`;

      if (templateRepository?.full_name === expectedFullName) {
        return data;
      }

      this.logger.warn(
        `Existing repo ${owner}/${name} was not generated from ${expectedFullName} ` +
          `(template_repository=${templateRepository?.full_name ?? 'none'})`,
      );
      return null;
    } catch (error) {
      const status = (error as { status?: number }).status;
      // 404 here would be very surprising (we just got a 422 saying it exists),
      // but treat any failure as "cannot verify" → fall through to 409.
      this.logger.warn(
        `Failed to fetch existing repo ${owner}/${name} for idempotency check (status=${status}): ${(error as Error).message}`,
      );
      return null;
    }
  }

  private toUseTemplateResponse(
    template: TemplateConfig,
    repo: GitHubRepoLike,
    fallbackOwner: string,
    alreadyExisted: boolean,
  ): UseTemplateResponseDto {
    return {
      templateRepo: `${this.templateOrg}/${template.repo}`,
      framework: template.framework,
      fullName: repo.full_name,
      owner: repo.owner?.login ?? fallbackOwner,
      name: repo.name,
      htmlUrl: repo.html_url,
      cloneUrl: repo.clone_url,
      defaultBranch: repo.default_branch ?? 'main',
      private: repo.private ?? true,
      alreadyExisted,
    };
  }
}

/**
 * Minimal subset of GitHub's repo response we actually use. Both
 * `repos.createUsingTemplate` and `repos.get` return supersets of this shape.
 */
interface GitHubRepoLike {
  full_name: string;
  name: string;
  owner?: { login: string } | null;
  html_url: string;
  clone_url: string;
  default_branch?: string | null;
  private?: boolean;
}
