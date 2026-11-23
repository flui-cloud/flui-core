import { Injectable, Logger } from '@nestjs/common';
import { Octokit } from '@octokit/rest';
import {
  IGitProvider,
  GitProviderCredentials,
} from '../interfaces/git-provider.interface';
import {
  GitRepositoryDto,
  GitBranchDto,
  GitCommitDto,
  GitWebhookDto,
  CreateWebhookDto,
} from '../dto/git-repository.dto';
import {
  githubCredentialRejected,
  isGithubCredentialRejection,
} from '../utils/github-credential-rejected';

@Injectable()
export class GitHubProviderService implements IGitProvider {
  private readonly logger = new Logger(GitHubProviderService.name);

  private failure(
    error: unknown,
    credentials: GitProviderCredentials,
    sentence: string,
  ): Error {
    return isGithubCredentialRejection(error)
      ? githubCredentialRejected(credentials.credential ?? 'github-account')
      : new Error(sentence);
  }

  private getOctokit(credentials: GitProviderCredentials): Octokit {
    return new Octokit({
      auth: credentials.accessToken,
    });
  }

  async listRepositories(
    credentials: GitProviderCredentials,
    page = 1,
    perPage = 30,
  ): Promise<GitRepositoryDto[]> {
    try {
      const octokit = this.getOctokit(credentials);
      const response = await octokit.repos.listForAuthenticatedUser({
        page,
        per_page: perPage,
        sort: 'updated',
        direction: 'desc',
      });

      return response.data.map((repo) => this.mapToRepositoryDto(repo));
    } catch (error) {
      this.logger.error('Failed to list GitHub repositories', error.stack);
      throw this.failure(
        error,
        credentials,
        `Failed to list repositories: ${error.message}`,
      );
    }
  }

  async getRepository(
    credentials: GitProviderCredentials,
    owner: string,
    repo: string,
  ): Promise<GitRepositoryDto> {
    try {
      const octokit = this.getOctokit(credentials);
      const response = await octokit.repos.get({ owner, repo });
      return this.mapToRepositoryDto(response.data);
    } catch (error) {
      this.logger.error(
        `Failed to get GitHub repository: ${owner}/${repo}`,
        error.stack,
      );
      throw this.failure(
        error,
        credentials,
        `Failed to get repository: ${error.message}`,
      );
    }
  }

  async listBranches(
    credentials: GitProviderCredentials,
    owner: string,
    repo: string,
  ): Promise<GitBranchDto[]> {
    try {
      const octokit = this.getOctokit(credentials);
      const response = await octokit.repos.listBranches({ owner, repo });

      return response.data.map((branch) => ({
        name: branch.name,
        commitSha: branch.commit.sha,
        protected: branch.protected,
      }));
    } catch (error) {
      this.logger.error(
        `Failed to list branches: ${owner}/${repo}`,
        error.stack,
      );
      throw this.failure(
        error,
        credentials,
        `Failed to list branches: ${error.message}`,
      );
    }
  }

  async getBranch(
    credentials: GitProviderCredentials,
    owner: string,
    repo: string,
    branchName: string,
  ): Promise<GitBranchDto> {
    try {
      const octokit = this.getOctokit(credentials);
      const response = await octokit.repos.getBranch({
        owner,
        repo,
        branch: branchName,
      });

      return {
        name: response.data.name,
        commitSha: response.data.commit.sha,
        protected: response.data.protected,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get branch: ${owner}/${repo}/${branchName}`,
        error.stack,
      );
      throw this.failure(
        error,
        credentials,
        `Failed to get branch: ${error.message}`,
      );
    }
  }

  async listCommits(
    credentials: GitProviderCredentials,
    owner: string,
    repo: string,
    branch?: string,
    limit = 10,
  ): Promise<GitCommitDto[]> {
    try {
      const octokit = this.getOctokit(credentials);
      const response = await octokit.repos.listCommits({
        owner,
        repo,
        sha: branch,
        per_page: limit,
      });

      return response.data.map((commit) => ({
        sha: commit.sha,
        message: commit.commit.message,
        author: {
          name: commit.commit.author.name,
          email: commit.commit.author.email,
          date: new Date(commit.commit.author.date),
        },
        committer: {
          name: commit.commit.committer.name,
          email: commit.commit.committer.email,
          date: new Date(commit.commit.committer.date),
        },
        url: commit.html_url,
      }));
    } catch (error) {
      this.logger.error(
        `Failed to list commits: ${owner}/${repo}`,
        error.stack,
      );
      throw this.failure(
        error,
        credentials,
        `Failed to list commits: ${error.message}`,
      );
    }
  }

  async getCommit(
    credentials: GitProviderCredentials,
    owner: string,
    repo: string,
    sha: string,
  ): Promise<GitCommitDto> {
    try {
      const octokit = this.getOctokit(credentials);
      const response = await octokit.repos.getCommit({ owner, repo, ref: sha });

      return {
        sha: response.data.sha,
        message: response.data.commit.message,
        author: {
          name: response.data.commit.author.name,
          email: response.data.commit.author.email,
          date: new Date(response.data.commit.author.date),
        },
        committer: {
          name: response.data.commit.committer.name,
          email: response.data.commit.committer.email,
          date: new Date(response.data.commit.committer.date),
        },
        url: response.data.html_url,
      };
    } catch (error) {
      this.logger.error(
        `Failed to get commit: ${owner}/${repo}/${sha}`,
        error.stack,
      );
      throw this.failure(
        error,
        credentials,
        `Failed to get commit: ${error.message}`,
      );
    }
  }

  async createWebhook(
    credentials: GitProviderCredentials,
    owner: string,
    repo: string,
    webhook: CreateWebhookDto,
  ): Promise<GitWebhookDto> {
    try {
      const octokit = this.getOctokit(credentials);
      const response = await octokit.repos.createWebhook({
        owner,
        repo,
        config: {
          url: webhook.url,
          content_type: 'json',
          secret: webhook.secret,
          insecure_ssl: '0',
        },
        events: webhook.events,
        active: true,
      });

      return {
        id: response.data.id.toString(),
        url: response.data.config.url,
        events: response.data.events,
        active: response.data.active,
        createdAt: new Date(response.data.created_at),
        updatedAt: new Date(response.data.updated_at),
      };
    } catch (error) {
      this.logger.error(
        `Failed to create webhook: ${owner}/${repo}`,
        error.stack,
      );
      throw this.failure(
        error,
        credentials,
        `Failed to create webhook: ${error.message}`,
      );
    }
  }

  async deleteWebhook(
    credentials: GitProviderCredentials,
    owner: string,
    repo: string,
    webhookId: string,
  ): Promise<void> {
    try {
      const octokit = this.getOctokit(credentials);
      await octokit.repos.deleteWebhook({
        owner,
        repo,
        hook_id: Number.parseInt(webhookId, 10),
      });

      this.logger.log(`Deleted webhook ${webhookId} from ${owner}/${repo}`);
    } catch (error) {
      this.logger.error(
        `Failed to delete webhook: ${owner}/${repo}/${webhookId}`,
        error.stack,
      );
      throw this.failure(
        error,
        credentials,
        `Failed to delete webhook: ${error.message}`,
      );
    }
  }

  async listWebhooks(
    credentials: GitProviderCredentials,
    owner: string,
    repo: string,
  ): Promise<GitWebhookDto[]> {
    try {
      const octokit = this.getOctokit(credentials);
      const response = await octokit.repos.listWebhooks({ owner, repo });

      return response.data.map((hook) => ({
        id: hook.id.toString(),
        url: hook.config.url,
        events: hook.events,
        active: hook.active,
        createdAt: new Date(hook.created_at),
        updatedAt: new Date(hook.updated_at),
      }));
    } catch (error) {
      this.logger.error(
        `Failed to list webhooks: ${owner}/${repo}`,
        error.stack,
      );
      throw this.failure(
        error,
        credentials,
        `Failed to list webhooks: ${error.message}`,
      );
    }
  }

  async testConnection(credentials: GitProviderCredentials): Promise<boolean> {
    try {
      const octokit = this.getOctokit(credentials);
      await octokit.users.getAuthenticated();
      return true;
    } catch (error) {
      this.logger.error('GitHub connection test failed', error.stack);
      return false;
    }
  }

  async getUserInfo(credentials: GitProviderCredentials): Promise<{
    id: string;
    username: string;
    email: string;
    name: string;
  }> {
    try {
      const octokit = this.getOctokit(credentials);
      const response = await octokit.users.getAuthenticated();

      return {
        id: response.data.id.toString(),
        username: response.data.login,
        email: response.data.email || '',
        name: response.data.name || response.data.login,
      };
    } catch (error) {
      this.logger.error('Failed to get GitHub user info', error.stack);
      throw this.failure(
        error,
        credentials,
        `Failed to get user info: ${error.message}`,
      );
    }
  }

  private mapToRepositoryDto(repo: {
    id: number;
    name: string;
    full_name: string;
    owner: { login: string };
    description: string | null;
    default_branch: string;
    private: boolean;
    clone_url: string;
    ssh_url: string;
    html_url: string;
    language: string | null;
    updated_at: string;
    created_at: string;
  }): GitRepositoryDto {
    return {
      id: repo.id.toString(),
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner.login,
      description: repo.description || '',
      defaultBranch: repo.default_branch,
      private: repo.private,
      cloneUrl: repo.clone_url,
      sshUrl: repo.ssh_url,
      htmlUrl: repo.html_url,
      language: repo.language || '',
      updatedAt: new Date(repo.updated_at),
      createdAt: new Date(repo.created_at),
    };
  }
}
