import {
  GitRepositoryDto,
  GitBranchDto,
  GitCommitDto,
  GitWebhookDto,
  CreateWebhookDto,
} from '../dto/git-repository.dto';
import { GithubCredential } from '../utils/github-credential-rejected';

export interface GitProviderCredentials {
  accessToken: string;
  credential?: GithubCredential;
  refreshToken?: string;
  expiresAt?: Date;
}

export interface IGitProvider {
  listRepositories(
    credentials: GitProviderCredentials,
    page?: number,
    perPage?: number,
  ): Promise<GitRepositoryDto[]>;

  getRepository(
    credentials: GitProviderCredentials,
    owner: string,
    repo: string,
  ): Promise<GitRepositoryDto>;

  listBranches(
    credentials: GitProviderCredentials,
    owner: string,
    repo: string,
  ): Promise<GitBranchDto[]>;

  getBranch(
    credentials: GitProviderCredentials,
    owner: string,
    repo: string,
    branchName: string,
  ): Promise<GitBranchDto>;

  listCommits(
    credentials: GitProviderCredentials,
    owner: string,
    repo: string,
    branch?: string,
    limit?: number,
  ): Promise<GitCommitDto[]>;

  getCommit(
    credentials: GitProviderCredentials,
    owner: string,
    repo: string,
    sha: string,
  ): Promise<GitCommitDto>;

  createWebhook(
    credentials: GitProviderCredentials,
    owner: string,
    repo: string,
    webhook: CreateWebhookDto,
  ): Promise<GitWebhookDto>;

  deleteWebhook(
    credentials: GitProviderCredentials,
    owner: string,
    repo: string,
    webhookId: string,
  ): Promise<void>;

  listWebhooks(
    credentials: GitProviderCredentials,
    owner: string,
    repo: string,
  ): Promise<GitWebhookDto[]>;

  testConnection(credentials: GitProviderCredentials): Promise<boolean>;

  getUserInfo(credentials: GitProviderCredentials): Promise<{
    id: string;
    username: string;
    email: string;
    name: string;
  }>;
}
