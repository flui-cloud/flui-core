import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { RepositoriesRepository } from '../repositories/repositories.repository';
import { RepositoryCredentialsRepository } from '../repositories/repository-credentials.repository';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { GitValidationService } from '../../shared/validation/services/git-validation.service';
import { GitHubProviderService } from '../../git/services/github-provider.service';
import { GitHubOAuthService } from './github-oauth.service';
import { GitHubTokenResolverService } from './github-token-resolver.service';
import { GitHubAppService } from './github-app.service';
import { GitCloneService } from '../../git/services/git-clone.service';
import { DetectionOrchestratorService } from '../../frameworks/framework-core/services/detection-orchestrator.service';
import { FrameworkBuildScoresService } from '../../frameworks/framework-core/services/framework-build-scores.service';
import { EnvExtractorService } from './env-extractor.service';
import {
  DockerfileAnalyzerService,
  DockerfileAnalysis,
} from './dockerfile-analyzer.service';
import { ExtractEnvDto, ExtractedEnvVarDto } from '../dto/extract-env.dto';
import { RepositoryEntity, GitProvider } from '../entities/repository.entity';
import { ConnectRepositoryResponseDto } from '../dto/create-repository.dto';
import {
  AvailableRepositoryDto,
  ImportRepositoriesDto,
  ImportRepositoriesResponseDto,
  ImportedRepositoryRefDto,
} from '../dto/github-oauth.dto';
import {
  AnalyzeRepositoryDto,
  RepositoryAnalysisDto,
  BuildScoresDto,
} from '../dto/analyze-repository.dto';
import { PublicRepositoryAnalyzeDto } from '../dto/public-repository-analyze.dto';
import {
  RepositoryManifestsDto,
  RepositoryManifestEntryDto,
} from '../dto/repository-manifest.dto';
import { validateApplicationManifest } from '../../applications/utils/application-manifest.util';
import * as yaml from 'js-yaml';

@Injectable()
export class RepositoriesService {
  private readonly logger = new Logger(RepositoriesService.name);

  constructor(
    private readonly repositoriesRepository: RepositoriesRepository,
    private readonly credentialsRepository: RepositoryCredentialsRepository,
    private readonly encryptionService: EncryptionService,
    private readonly gitValidationService: GitValidationService,
    private readonly githubProviderService: GitHubProviderService,
    private readonly githubOAuthService: GitHubOAuthService,
    private readonly tokenResolver: GitHubTokenResolverService,
    private readonly githubAppService: GitHubAppService,
    private readonly gitCloneService: GitCloneService,
    private readonly detectionOrchestrator: DetectionOrchestratorService,
    private readonly frameworkBuildScores: FrameworkBuildScoresService,
    private readonly envExtractor: EnvExtractorService,
    private readonly dockerfileAnalyzer: DockerfileAnalyzerService,
  ) {}

  /**
   * Connect a repository by URL, resolving the user's GitHub token SERVER-SIDE.
   * Lets an agent connect `owner/repo` without ever handling the access token
   * (credentials stay out of the LLM). Requires GitHub already connected.
   */
  async connectRepositoryByUrl(
    userId: string,
    repositoryUrl: string,
    autoDeployEnabled = false,
  ): Promise<ConnectRepositoryResponseDto> {
    const parsed = this.gitValidationService.parseGitUrl(repositoryUrl);
    if (!parsed) {
      throw new BadRequestException('Failed to parse Git repository URL');
    }
    const owner = parsed.fullName.split('/')[0];
    const accessToken = await this.tokenResolver.getAccessToken(userId, owner);
    return this.connectRepository(
      userId,
      repositoryUrl,
      accessToken,
      GitProvider.GITHUB,
      autoDeployEnabled,
    );
  }

  async connectRepository(
    userId: string,
    repositoryUrl: string,
    accessToken: string,
    provider: GitProvider = GitProvider.GITHUB,
    autoDeployEnabled = false,
  ): Promise<ConnectRepositoryResponseDto> {
    this.logger.log(
      `Connecting repository for user ${userId}: ${repositoryUrl}`,
    );

    if (!this.gitValidationService.validateGitUrl(repositoryUrl)) {
      throw new BadRequestException('Invalid Git repository URL');
    }

    const parsedUrl = this.gitValidationService.parseGitUrl(repositoryUrl);
    if (!parsedUrl) {
      throw new BadRequestException('Failed to parse Git repository URL');
    }

    const existing = await this.repositoriesRepository.findByUserIdAndFullName(
      userId,
      parsedUrl.fullName,
    );

    if (existing) {
      throw new BadRequestException('Repository already connected');
    }

    let repositoryInfo;
    try {
      if (provider === GitProvider.GITHUB) {
        repositoryInfo = await this.githubProviderService.getRepository(
          { accessToken },
          parsedUrl.owner,
          parsedUrl.repo,
        );
      } else {
        throw new BadRequestException(`Provider ${provider} not yet supported`);
      }
    } catch (error) {
      this.logger.error(`Failed to fetch repository info`, error.stack);
      throw new BadRequestException(
        'Failed to fetch repository information. Check your access token.',
      );
    }

    const encryptedToken = this.encryptionService.encrypt(accessToken);

    const repository = await this.repositoriesRepository.create({
      userId,
      provider,
      repositoryUrl,
      repositoryName: repositoryInfo.name,
      repositoryFullName: repositoryInfo.fullName,
      owner: repositoryInfo.owner,
      defaultBranch: repositoryInfo.defaultBranch,
      isPrivate: repositoryInfo.private,
      cloneUrl: repositoryInfo.cloneUrl,
      sshUrl: repositoryInfo.sshUrl,
      htmlUrl: repositoryInfo.htmlUrl,
      description: repositoryInfo.description,
      language: repositoryInfo.language,
      accessTokenEncrypted: encryptedToken,
      autoDeployEnabled,
      lastSyncAt: new Date(),
    });

    this.logger.log(`Repository connected successfully: ${repository.id}`);

    return this.mapToResponseDto(repository);
  }

  async listAvailableRepositories(
    userId: string,
  ): Promise<AvailableRepositoryDto[]> {
    this.logger.log(`Listing available repositories for user ${userId}`);

    let repos: any[];

    if (await this.githubAppService.isEnabled()) {
      // GitHub App mode: only the installations this user reaches — listing
      // every installation on the instance hands one tenant another's repos.
      const installations =
        await this.githubAppService.listReachableInstallations(userId);
      repos = [];
      for (const installation of installations) {
        const octokit = await this.githubAppService.getInstallationOctokit(
          userId,
          installation.accountLogin,
        );
        const { data } = await octokit.apps.listReposAccessibleToInstallation({
          per_page: 100,
        });
        repos.push(...data.repositories);
      }
    } else {
      // OAuth/PAT mode: list repos for the authenticated user
      const octokit = await this.githubOAuthService.getOctokit(userId);
      const { data } = await octokit.repos.listForAuthenticatedUser({
        visibility: 'all',
        per_page: 100,
        sort: 'updated',
        direction: 'desc',
      });
      repos = data;
    }

    const importedRepos =
      await this.repositoriesRepository.findByUserId(userId);
    const importedFullNames = new Set(
      importedRepos.map((r) => r.repositoryFullName),
    );

    return repos.map((repo) => ({
      id: repo.id.toString(),
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner.login,
      description: repo.description || '',
      defaultBranch: repo.default_branch,
      private: repo.private,
      cloneUrl: repo.clone_url,
      htmlUrl: repo.html_url,
      language: repo.language || '',
      updatedAt: new Date(repo.updated_at),
      isImported: importedFullNames.has(repo.full_name),
    }));
  }

  async importRepositories(
    userId: string,
    dto: ImportRepositoriesDto,
  ): Promise<ImportRepositoriesResponseDto> {
    this.logger.log(
      `Importing ${dto.repositoryIds.length} repositories for user ${userId}`,
    );

    const isAppMode = await this.tokenResolver.isAppMode();

    const repositories: ImportedRepositoryRefDto[] = [];
    let importedCount = 0;
    let skippedCount = 0;
    const errors: string[] = [];

    for (const repoFullName of dto.repositoryIds) {
      try {
        const [owner, repoName] = repoFullName.split('/');
        if (!owner || !repoName) {
          throw new Error(
            `Invalid repository format: ${repoFullName}. Expected format: owner/repo`,
          );
        }

        const existing =
          await this.repositoriesRepository.findByUserIdAndFullName(
            userId,
            repoFullName,
          );

        if (existing) {
          this.logger.log(
            `Repository ${repoFullName} already imported (id=${existing.id}), returning existing reference`,
          );
          repositories.push({
            id: existing.id,
            fullName: existing.repositoryFullName,
            status: 'already_imported',
          });
          skippedCount++;
          continue;
        }

        const repoOctokit = await this.tokenResolver.getOctokit(userId, owner);
        const { data: repo } = await repoOctokit.repos.get({
          owner,
          repo: repoName,
        });

        let encryptedToken: string;
        if (isAppMode) {
          const installationToken = await this.tokenResolver.getAccessToken(
            userId,
            owner,
          );
          encryptedToken = this.encryptionService.encrypt(installationToken);
        } else {
          const credential =
            await this.githubOAuthService.getActiveCredential(userId);
          const accessToken = this.encryptionService.decrypt(
            credential.accessTokenEncrypted,
          );
          encryptedToken = this.encryptionService.encrypt(accessToken);
        }

        const created = await this.repositoriesRepository.create({
          userId,
          provider: GitProvider.GITHUB,
          repositoryUrl: repo.html_url,
          repositoryName: repo.name,
          repositoryFullName: repo.full_name,
          owner: repo.owner.login,
          defaultBranch: repo.default_branch,
          isPrivate: repo.private,
          cloneUrl: repo.clone_url,
          sshUrl: repo.ssh_url,
          htmlUrl: repo.html_url,
          description: repo.description || '',
          language: repo.language || '',
          accessTokenEncrypted: encryptedToken,
          autoDeployEnabled: dto.autoDeployEnabled || false,
          lastSyncAt: new Date(),
        });

        repositories.push({
          id: created.id,
          fullName: created.repositoryFullName,
          status: 'imported',
        });
        importedCount++;
        this.logger.log(
          `Imported repository: ${repo.full_name} (id=${created.id})`,
        );
      } catch (error) {
        const errorMsg = `Failed to import repository ${repoFullName}: ${error.message}`;
        this.logger.error(errorMsg, error.stack);
        errors.push(errorMsg);
      }
    }

    return {
      imported: importedCount,
      skipped: skippedCount,
      failed: errors.length,
      repositories,
      importedRepositoryIds: repositories.map((r) => r.id),
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  async listRepositories(
    userId: string,
  ): Promise<ConnectRepositoryResponseDto[]> {
    const repositories = await this.repositoriesRepository.findByUserId(userId);
    return repositories.map((repo) => this.mapToResponseDto(repo));
  }

  async getRepository(
    userId: string,
    repositoryId: string,
  ): Promise<ConnectRepositoryResponseDto> {
    const repository = await this.repositoriesRepository.findById(repositoryId);

    if (repository?.userId !== userId) {
      throw new NotFoundException('Repository not found');
    }

    return this.mapToResponseDto(repository);
  }

  async deleteRepository(userId: string, repositoryId: string): Promise<void> {
    const repository = await this.repositoriesRepository.findById(repositoryId);

    if (repository?.userId !== userId) {
      throw new NotFoundException('Repository not found');
    }

    if (repository.webhookId && repository.webhookActive) {
      try {
        const accessToken = await this.resolveAccessToken(userId, repository);
        const parsedUrl = this.gitValidationService.parseGitUrl(
          repository.repositoryUrl,
        );

        if (repository.provider === GitProvider.GITHUB && parsedUrl) {
          await this.githubProviderService.deleteWebhook(
            { accessToken },
            parsedUrl.owner,
            parsedUrl.repo,
            repository.webhookId,
          );
        }
      } catch (error) {
        this.logger.warn(
          `Failed to delete webhook during repository deletion`,
          error.stack,
        );
      }
    }

    await this.repositoriesRepository.delete(repositoryId);
    this.logger.log(`Repository deleted: ${repositoryId}`);
  }

  async listBranches(userId: string, repositoryId: string) {
    const repository = await this.repositoriesRepository.findById(repositoryId);

    if (repository?.userId !== userId) {
      throw new NotFoundException('Repository not found');
    }

    const accessToken = await this.resolveAccessToken(userId, repository);
    const parsedUrl = this.gitValidationService.parseGitUrl(
      repository.repositoryUrl,
    );

    if (!parsedUrl) {
      throw new BadRequestException('Invalid repository URL');
    }

    if (repository.provider === GitProvider.GITHUB) {
      return this.githubProviderService.listBranches(
        { accessToken },
        parsedUrl.owner,
        parsedUrl.repo,
      );
    }

    throw new BadRequestException(
      `Provider ${repository.provider} not yet supported`,
    );
  }

  async listCommits(
    userId: string,
    repositoryId: string,
    branch?: string,
    limit = 10,
  ) {
    const repository = await this.repositoriesRepository.findById(repositoryId);

    if (repository?.userId !== userId) {
      throw new NotFoundException('Repository not found');
    }

    const accessToken = await this.resolveAccessToken(userId, repository);
    const parsedUrl = this.gitValidationService.parseGitUrl(
      repository.repositoryUrl,
    );

    if (!parsedUrl) {
      throw new BadRequestException('Invalid repository URL');
    }

    if (repository.provider === GitProvider.GITHUB) {
      return this.githubProviderService.listCommits(
        { accessToken },
        parsedUrl.owner,
        parsedUrl.repo,
        branch || repository.defaultBranch,
        limit,
      );
    }

    throw new BadRequestException(
      `Provider ${repository.provider} not yet supported`,
    );
  }

  async testConnection(
    userId: string,
    repositoryId: string,
  ): Promise<{ success: boolean; message: string }> {
    const repository = await this.repositoriesRepository.findById(repositoryId);

    if (repository?.userId !== userId) {
      throw new NotFoundException('Repository not found');
    }

    try {
      const accessToken = await this.resolveAccessToken(userId, repository);

      if (repository.provider === GitProvider.GITHUB) {
        const success = await this.githubProviderService.testConnection({
          accessToken,
        });
        return {
          success,
          message: success ? 'Connection successful' : 'Connection failed',
        };
      }

      throw new BadRequestException(
        `Provider ${repository.provider} not yet supported`,
      );
    } catch (error) {
      this.logger.error(
        `Connection test failed for repository ${repositoryId}`,
        error.stack,
      );
      return {
        success: false,
        message: error.message,
      };
    }
  }

  /**
   * Analyze repository for framework detection and build plan generation
   * This method clones the repository, detects the framework, and generates a build plan
   */
  async analyzeRepository(
    userId: string,
    repositoryId: string,
    dto: AnalyzeRepositoryDto,
  ): Promise<RepositoryAnalysisDto> {
    this.logger.log(`Analyzing repository ${repositoryId} for user ${userId}`);

    // Get repository
    const repository = await this.repositoriesRepository.findById(repositoryId);

    if (repository?.userId !== userId) {
      throw new NotFoundException('Repository not found');
    }

    const branchToAnalyze = dto.branch || repository.defaultBranch;
    this.logger.log(`Using branch: ${branchToAnalyze}`);

    // Resolve access token (fresh installation token in App mode)
    const accessToken = await this.resolveAccessToken(userId, repository);

    let cloneResult;
    let commitSha: string;

    try {
      // Clone repository (shallow clone for performance)
      this.logger.log(`Cloning repository ${repository.repositoryFullName}`);
      try {
        cloneResult = await this.gitCloneService.cloneRepository(
          repository.cloneUrl,
          accessToken,
          {
            branch: branchToAnalyze,
            depth: 1,
            singleBranch: true,
          },
        );
      } catch (cloneError) {
        const msg: string = cloneError?.message ?? '';
        if (
          msg.includes('not found in upstream') ||
          msg.includes('Remote branch')
        ) {
          throw new NotFoundException(
            `Branch "${branchToAnalyze}" not found in repository ${repository.repositoryFullName}`,
          );
        }
        throw new InternalServerErrorException(
          `Failed to clone repository: ${msg}`,
        );
      }

      if (!cloneResult.success) {
        throw new InternalServerErrorException(
          `Failed to clone repository: ${cloneResult.error}`,
        );
      }

      // If specific commit requested, checkout that commit
      if (dto.commitSha) {
        this.logger.log(`Checking out commit ${dto.commitSha}`);
        await this.gitCloneService.checkoutCommit(
          cloneResult.localPath,
          dto.commitSha,
        );
        commitSha = dto.commitSha;
      } else {
        // Get latest commit SHA
        commitSha = await this.gitCloneService.getLatestCommitSha(
          cloneResult.localPath,
        );
      }

      // Run framework detection and build plan generation
      this.logger.log('Running framework detection and build plan generation');
      const result =
        await this.detectionOrchestrator.detectFrameworkAndGenerateBuildPlan(
          cloneResult.localPath,
        );

      if (!result) {
        throw new BadRequestException(
          'Could not detect framework. Make sure the repository contains a supported framework.',
        );
      }

      this.logger.log(
        `Detected framework: ${result.detection.framework} (confidence: ${result.detection.confidence}%)`,
      );

      // V3: Analyze Dockerfile if present
      let dockerfileAnalysis: DockerfileAnalysis | undefined;
      try {
        const dockerfilePath = path.join(cloneResult.localPath, 'Dockerfile');
        const dockerfileContent = await fs.readFile(dockerfilePath, 'utf-8');
        dockerfileAnalysis = this.dockerfileAnalyzer.analyze(dockerfileContent);
      } catch {
        // No Dockerfile — field stays undefined
      }

      // Compute deployability scores and recommendation
      const scores = await this.computeScores(
        result.detection,
        cloneResult.localPath,
      );
      const recommended = await this.determineRecommended(
        scores,
        cloneResult.localPath,
      );

      // Map detection result and build plan to DTOs
      const analysisDto: RepositoryAnalysisDto = {
        repositoryId: repository.id,
        branch: branchToAnalyze,
        commitSha,
        detection: {
          framework: result.detection.framework,
          confidence: result.detection.confidence,
          version: result.detection.version,
          majorVersion: result.detection.majorVersion,
          buildMode: result.detection.buildMode,
          features: result.detection.features,
          packageManager: result.detection.packageManager,
          nodeVersion: result.detection.nodeVersion,
          warnings: result.detection.warnings,
          metadata: result.detection.metadata,
          detectorName: result.detection.detectorName,
        },
        buildPlan: {
          framework: result.buildPlan.framework,
          version: result.buildPlan.version,
          buildMode: result.buildPlan.buildMode,
          dockerfile: result.buildPlan.dockerfile,
          buildContext: result.buildPlan.buildContext,
          buildArgs: result.buildPlan.buildArgs,
          buildEnv: result.buildPlan.buildEnv,
          runtimeEnv: result.buildPlan.runtimeEnv,
          resources: result.buildPlan.resources,
          healthCheck: result.buildPlan.healthCheck,
          networking: result.buildPlan.networking,
          scaling: result.buildPlan.scaling,
          metadata: result.buildPlan.metadata,
          envVarSuggestions: result.buildPlan.envVarSuggestions,
        },
        scores,
        recommended,
        alternatives: result.alternatives,
        supported: scores.githubActions >= 50 || scores.railpack >= 50,
        dockerfileAnalysis: dockerfileAnalysis ?? undefined,
        analyzedAt: new Date(),
      };

      this.logger.log(
        `Repository analysis completed successfully for ${repository.repositoryFullName}`,
      );

      return analysisDto;
    } catch (error) {
      this.logger.error(
        `Failed to analyze repository ${repositoryId}`,
        error.stack,
      );
      throw error;
    } finally {
      // Always cleanup cloned repository
      if (cloneResult?.localPath) {
        this.logger.log(
          `Cleaning up temporary clone at ${cloneResult.localPath}`,
        );
        await this.gitCloneService.cleanup(cloneResult.localPath);
      }
    }
  }

  /**
   * Analyze a public GitHub repository without requiring it to be imported.
   * Clones without authentication — only public HTTPS GitHub URLs are accepted.
   */
  async analyzePublicRepository(
    dto: PublicRepositoryAnalyzeDto,
  ): Promise<RepositoryAnalysisDto> {
    this.logger.log(
      `Analyzing public repository: ${dto.cloneUrl} on branch ${dto.branch ?? 'default'}`,
    );

    let cloneResult;
    let commitSha: string;

    try {
      try {
        cloneResult = await this.gitCloneService.cloneRepository(
          dto.cloneUrl,
          '',
          {
            ...(dto.branch ? { branch: dto.branch } : {}),
            depth: 1,
            singleBranch: !!dto.branch,
          },
        );
      } catch (cloneError) {
        const msg: string = cloneError?.message ?? '';
        if (
          msg.includes('not found in upstream') ||
          msg.includes('Remote branch')
        ) {
          throw new NotFoundException(
            `Branch "${dto.branch}" not found in repository ${dto.cloneUrl}`,
          );
        }
        throw new InternalServerErrorException(
          `Failed to clone repository: ${msg}`,
        );
      }

      if (!cloneResult.success) {
        throw new InternalServerErrorException(
          `Failed to clone repository: ${cloneResult.error}`,
        );
      }

      commitSha = await this.gitCloneService.getLatestCommitSha(
        cloneResult.localPath,
      );

      this.logger.log('Running framework detection and build plan generation');
      const result =
        await this.detectionOrchestrator.detectFrameworkAndGenerateBuildPlan(
          cloneResult.localPath,
        );

      if (!result) {
        throw new BadRequestException(
          'Could not detect framework. Make sure the repository contains a supported framework.',
        );
      }

      this.logger.log(
        `Detected framework: ${result.detection.framework} (confidence: ${result.detection.confidence}%)`,
      );

      let dockerfileAnalysis: DockerfileAnalysis | undefined;
      try {
        const dockerfilePath = path.join(cloneResult.localPath, 'Dockerfile');
        const dockerfileContent = await fs.readFile(dockerfilePath, 'utf-8');
        dockerfileAnalysis = this.dockerfileAnalyzer.analyze(dockerfileContent);
      } catch {
        // No Dockerfile
      }

      const scores = await this.computeScores(
        result.detection,
        cloneResult.localPath,
      );
      const recommended = await this.determineRecommended(
        scores,
        cloneResult.localPath,
      );

      const analysisDto: RepositoryAnalysisDto = {
        branch: dto.branch ?? '',
        commitSha,
        detection: {
          framework: result.detection.framework,
          confidence: result.detection.confidence,
          version: result.detection.version,
          majorVersion: result.detection.majorVersion,
          buildMode: result.detection.buildMode,
          features: result.detection.features,
          packageManager: result.detection.packageManager,
          nodeVersion: result.detection.nodeVersion,
          warnings: result.detection.warnings,
          metadata: result.detection.metadata,
          detectorName: result.detection.detectorName,
        },
        buildPlan: {
          framework: result.buildPlan.framework,
          version: result.buildPlan.version,
          buildMode: result.buildPlan.buildMode,
          dockerfile: result.buildPlan.dockerfile,
          buildContext: result.buildPlan.buildContext,
          buildArgs: result.buildPlan.buildArgs,
          buildEnv: result.buildPlan.buildEnv,
          runtimeEnv: result.buildPlan.runtimeEnv,
          resources: result.buildPlan.resources,
          healthCheck: result.buildPlan.healthCheck,
          networking: result.buildPlan.networking,
          scaling: result.buildPlan.scaling,
          metadata: result.buildPlan.metadata,
          envVarSuggestions: result.buildPlan.envVarSuggestions,
        },
        scores,
        recommended,
        alternatives: result.alternatives,
        supported: scores.githubActions >= 50 || scores.railpack >= 50,
        dockerfileAnalysis: dockerfileAnalysis ?? undefined,
        analyzedAt: new Date(),
      };

      this.logger.log(
        `Public repository analysis completed for ${dto.cloneUrl}`,
      );
      return analysisDto;
    } catch (error) {
      this.logger.error(
        `Failed to analyze public repository ${dto.cloneUrl}`,
        error.stack,
      );
      throw error;
    } finally {
      if (cloneResult?.localPath) {
        this.logger.log(
          `Cleaning up temporary clone at ${cloneResult.localPath}`,
        );
        await this.gitCloneService.cleanup(cloneResult.localPath);
      }
    }
  }

  /**
   * V3: Lightweight check for Dockerfile presence via GitHub API (no clone).
   * Used by the frontend to decide between Path A (Dockerfile) and Templates redirect.
   */
  async checkDockerfilePresence(
    userId: string,
    owner: string,
    repo: string,
  ): Promise<{ hasDockerfile: boolean }> {
    try {
      const octokit = await this.tokenResolver.getOctokit(userId, owner);
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: '',
      });

      if (!Array.isArray(data)) {
        return { hasDockerfile: false };
      }

      const hasDockerfile = data.some(
        (item: { name: string; type: string }) =>
          item.type === 'file' && item.name === 'Dockerfile',
      );

      return { hasDockerfile };
    } catch (error) {
      this.logger.warn(
        `Could not check Dockerfile presence for ${owner}/${repo}: ${error.message}`,
      );
      return { hasDockerfile: false };
    }
  }

  /**
   * Discover and validate flui.yaml manifests in the repository — at the root
   * and in subdirectories (monorepo: one manifest per deployable). Lightweight
   * reads via GitHub API, no clone. Drives the manifest-first deploy flow
   * (dashboard parity with `flui deploy <path>`).
   */
  async getFluiManifests(
    userId: string,
    owner: string,
    repo: string,
    ref: string,
  ): Promise<RepositoryManifestsDto> {
    const MAX_DEPTH = 4;
    const MAX_MANIFESTS = 10;

    let paths: string[];
    let octokit: Awaited<ReturnType<GitHubTokenResolverService['getOctokit']>>;
    try {
      octokit = await this.tokenResolver.getOctokit(userId, owner);
      const { data: tree } = await octokit.git.getTree({
        owner,
        repo,
        tree_sha: ref,
        recursive: '1',
      });
      paths = (tree.tree ?? [])
        .filter(
          (item) =>
            item.type === 'blob' &&
            !!item.path &&
            /(^|\/)flui\.ya?ml$/.test(item.path) &&
            !item.path.includes('node_modules/') &&
            item.path.split('/').length <= MAX_DEPTH,
        )
        .map((item) => item.path as string)
        .sort(
          (a, b) =>
            a.split('/').length - b.split('/').length || a.localeCompare(b),
        )
        .slice(0, MAX_MANIFESTS);
    } catch (error) {
      if (error?.status === 404) {
        // Empty repo or unknown ref — treat as "no manifests".
        return { branch: ref, manifests: [] };
      }
      this.logger.warn(
        `Could not list flui.yaml manifests for ${owner}/${repo}@${ref}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        `Could not read repository tree for ${owner}/${repo}: ${error.message}`,
      );
    }

    const manifests: RepositoryManifestEntryDto[] = [];
    for (const manifestPath of paths) {
      const content = await this.readRepoFile(
        octokit,
        owner,
        repo,
        ref,
        manifestPath,
      );
      if (content === null) continue;
      manifests.push(this.toManifestEntry(manifestPath, content));
    }

    return { branch: ref, manifests };
  }

  private toManifestEntry(
    manifestPath: string,
    content: string,
  ): RepositoryManifestEntryDto {
    let kind: string | undefined;
    try {
      const doc = yaml.load(content) as Record<string, unknown> | null;
      kind = typeof doc?.['kind'] === 'string' ? doc['kind'] : undefined;
    } catch {
      // Invalid YAML — kind stays undefined; the validator below reports it.
    }

    try {
      const { manifest, warnings } = validateApplicationManifest(content);
      return {
        path: manifestPath,
        valid: true,
        kind,
        name: manifest.metadata.name,
        port: manifest.deploy.port,
        content,
        manifest: manifest as unknown as Record<string, unknown>,
        warnings: warnings.length
          ? warnings.map((w) => `${w.path}: ${w.message}`)
          : undefined,
      };
    } catch (error) {
      return {
        path: manifestPath,
        valid: false,
        kind,
        content,
        validationError: error.message,
      };
    }
  }

  private async readRepoFile(
    octokit: Awaited<ReturnType<GitHubTokenResolverService['getOctokit']>>,
    owner: string,
    repo: string,
    ref: string,
    filePath: string,
  ): Promise<string | null> {
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref,
      });
      const file = data as { encoding?: string; content?: string };
      if (file.encoding !== 'base64' || !file.content) return null;
      return Buffer.from(file.content, 'base64').toString('utf-8');
    } catch (error) {
      this.logger.warn(
        `Could not read ${filePath} from ${owner}/${repo}@${ref}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Clone repository and extract environment variable keys from framework config files.
   */
  async extractEnv(
    userId: string,
    repositoryId: string,
    dto: ExtractEnvDto,
  ): Promise<ExtractedEnvVarDto[]> {
    this.logger.log(
      `Extracting env vars for repository ${repositoryId}, framework ${dto.framework}`,
    );

    const repository = await this.repositoriesRepository.findById(repositoryId);

    if (repository?.userId !== userId) {
      throw new NotFoundException('Repository not found');
    }

    const accessToken = await this.resolveAccessToken(userId, repository);

    let cloneResult;

    try {
      cloneResult = await this.gitCloneService.cloneRepository(
        repository.cloneUrl,
        accessToken,
        {
          branch: dto.branch,
          depth: 1,
          singleBranch: true,
        },
      );

      if (!cloneResult.success) {
        throw new InternalServerErrorException(
          `Failed to clone repository: ${cloneResult.error}`,
        );
      }

      return await this.envExtractor.extractFromRepo(
        cloneResult.localPath,
        dto.framework,
      );
    } finally {
      if (cloneResult?.localPath) {
        await this.gitCloneService.cleanup(cloneResult.localPath);
      }
    }
  }

  async updateFrameworkInfo(
    repositoryId: string,
    data: {
      detectedFramework?: string;
      detectedFrontendFramework?: string;
      detectedPort?: number;
    },
  ): Promise<void> {
    await this.repositoriesRepository.update(repositoryId, data as any);
    this.logger.log(
      `Updated framework info for repository ${repositoryId}: framework=${data.detectedFramework}, port=${data.detectedPort}`,
    );
  }

  /**
   * Compute GitHub Actions and Railpack deployability scores for a detection result.
   * GHA score: seeded base from DB, adjusted by detection quality factors.
   * Railpack score: directly from DB (updated by automation).
   */
  private async computeScores(
    detection: {
      framework: string;
      packageManager?: string;
      version?: string;
      warnings?: string[];
    },
    repoPath: string,
  ): Promise<BuildScoresDto> {
    const dbScores = await this.frameworkBuildScores.getScores(
      detection.framework,
    );

    let ghaScore = dbScores.githubActions;

    // Bonus: package manager identified
    if (detection.packageManager) {
      ghaScore = Math.min(100, ghaScore + 5);
    }

    // Penalty: monorepo warning
    const hasMonorepoWarning = (detection.warnings || []).some((w) =>
      w.toLowerCase().includes('monorepo'),
    );
    if (hasMonorepoWarning) {
      ghaScore = Math.max(0, ghaScore - 20);
    }

    // Bonus: Dockerfile already present (user owns build context)
    try {
      await fs.access(path.join(repoPath, 'Dockerfile'));
      ghaScore = Math.min(100, ghaScore + 5);
    } catch {
      // No Dockerfile — no adjustment
    }

    return {
      githubActions: Math.round(ghaScore),
      railpack: dbScores.railpack,
    };
  }

  /**
   * Determine the recommended build path.
   * If a #flui-managed Dockerfile exists: 'dockerfile'.
   * Otherwise: whichever score is higher.
   */
  private async determineRecommended(
    scores: BuildScoresDto,
    repoPath: string,
  ): Promise<'github-actions' | 'railpack' | 'dockerfile' | null> {
    try {
      const dockerfilePath = path.join(repoPath, 'Dockerfile');
      const content = await fs.readFile(dockerfilePath, 'utf-8');
      if (content.includes('#flui-managed')) {
        return 'dockerfile';
      }
    } catch {
      // No Dockerfile or unreadable
    }

    if (scores.githubActions === 0 && scores.railpack === 0) {
      return null;
    }

    return scores.githubActions >= scores.railpack
      ? 'github-actions'
      : 'railpack';
  }

  private mapToResponseDto(
    repository: RepositoryEntity,
  ): ConnectRepositoryResponseDto {
    return {
      id: repository.id,
      provider: repository.provider,
      repositoryName: repository.repositoryName,
      repositoryFullName: repository.repositoryFullName,
      owner: repository.owner,
      defaultBranch: repository.defaultBranch,
      isPrivate: repository.isPrivate,
      cloneUrl: repository.cloneUrl,
      htmlUrl: repository.htmlUrl,
      description: repository.description,
      language: repository.language,
      webhookActive: repository.webhookActive,
      autoDeployEnabled: repository.autoDeployEnabled,
      createdAt: repository.createdAt,
    };
  }

  /**
   * Resolve a fresh access token for a repository.
   * In GitHub App mode, fetches a new installation token (the stored one may be expired).
   * In OAuth/PAT mode, decrypts the stored token (long-lived).
   */
  private async resolveAccessToken(
    userId: string,
    repository: RepositoryEntity,
  ): Promise<string> {
    if (await this.tokenResolver.isAppMode()) {
      return this.tokenResolver.getAccessToken(userId, repository.owner);
    }
    return this.encryptionService.decrypt(repository.accessTokenEncrypted);
  }
}
