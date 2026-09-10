import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { Octokit } from '@octokit/rest';
import { FrameworkRegistryService } from './framework-registry.service';
import { ConfidenceScorerService } from './confidence-scorer.service';
import { IDetectionContext, IDetectionResult, IBuildPlan } from '../interfaces';
import { IFluiConfig } from '../interfaces/detection-context.interface';
import { FrameworkType, DeployStrategy } from '../enums';
import { EnvVarDetectorService } from '../../env-var-detection/services/env-var-detector.service';
import { EnvVarSource } from '../enums/env-var-source.enum';
import { IDetectedEnvVar } from '../interfaces/env-var-detection.interface';

/**
 * Orchestrates the framework detection process
 * Coordinates multiple detectors and selects the best match
 */
@Injectable()
export class DetectionOrchestratorService {
  private readonly logger = new Logger(DetectionOrchestratorService.name);

  constructor(
    private readonly registry: FrameworkRegistryService,
    private readonly scorer: ConfidenceScorerService,
    private readonly envVarDetector: EnvVarDetectorService,
  ) {}

  /**
   * Detect framework for a given repository
   */
  async detectFramework(
    repositoryPath: string,
  ): Promise<IDetectionResult | null> {
    this.logger.log(`Starting framework detection for: ${repositoryPath}`);

    // Step 1: Prepare detection context
    const context = await this.prepareContext(repositoryPath);

    // Step 2: Check if user specified framework in .flui.yaml
    if (context.fluiConfig?.framework?.name) {
      this.logger.log(
        `User specified framework in .flui.yaml: ${context.fluiConfig.framework.name}`,
      );
      return this.detectSpecificFramework(
        context,
        context.fluiConfig.framework.name,
      );
    }

    // Step 3: Run all capable detectors in parallel
    this.logger.log('Running capable detectors');
    const successfulResults = await this.runAllDetectors(context);

    if (successfulResults.length === 0) {
      this.logger.warn('No detectors capable of detecting this repository');
      return null;
    }

    // Step 4: Select best match
    const bestMatch = this.scorer.selectBestMatch(successfulResults);

    if (!bestMatch) {
      return null;
    }

    this.logger.log(
      `Selected framework: ${bestMatch.framework} (confidence: ${bestMatch.confidence}%)`,
    );

    // Step 6: Validate confidence
    const confidenceCheck = this.scorer.isConfidenceSufficient(
      bestMatch.confidence,
    );

    if (!confidenceCheck.sufficient) {
      this.logger.warn(confidenceCheck.message);
      bestMatch.warnings = [
        ...(bestMatch.warnings || []),
        confidenceCheck.message,
      ];
    }

    return bestMatch;
  }

  /**
   * Detect framework and generate build plan in one call
   * This is the recommended method for analyzing repositories
   */
  async detectFrameworkAndGenerateBuildPlan(repositoryPath: string): Promise<{
    detection: IDetectionResult;
    buildPlan: IBuildPlan;
    alternatives: string[];
  } | null> {
    this.logger.log(
      `Starting framework detection and build plan generation for: ${repositoryPath}`,
    );

    // Step 1: Prepare detection context
    const context = await this.prepareContext(repositoryPath);

    // Step 2: Run all detectors to get ranked results (used for best match + alternatives)
    const allResults = await this.runAllDetectors(context);

    if (allResults.length === 0) {
      return null;
    }

    const detectionResult = this.scorer.selectBestMatch(allResults);

    if (!detectionResult) {
      return null;
    }

    // Collect alternative frameworks: top results excluding the winner, confidence >= 50
    const alternatives = allResults
      .filter(
        (r) => r.framework !== detectionResult.framework && r.confidence >= 50,
      )
      .slice(0, 3)
      .map((r) => r.framework as string);

    // Apply confidence check warnings
    const confidenceCheck = this.scorer.isConfidenceSufficient(
      detectionResult.confidence,
    );
    if (!confidenceCheck.sufficient) {
      detectionResult.warnings = [
        ...(detectionResult.warnings || []),
        confidenceCheck.message,
      ];
    }

    // Step 3: Get the detector
    const detector = this.registry.getDetector(detectionResult.framework);

    if (!detector) {
      this.logger.error(
        `No detector found for framework: ${detectionResult.framework}`,
      );
      return null;
    }

    // Step 4: Generate build plan
    this.logger.log('Generating build plan');
    const buildPlan = await detector.generateBuildPlan(
      detectionResult,
      context,
    );

    // Step 5: Detect env var suggestions (source code only — DOCKER_IMAGE deployments
    // never reach this path since they don't go through repository analysis)
    const detectorForEnv = this.registry.getDetector(detectionResult.framework);
    const envFileHints =
      detectorForEnv && typeof detectorForEnv.getEnvFileHints === 'function'
        ? detectorForEnv.getEnvFileHints()
        : [];

    buildPlan.envVarSuggestions = await this.envVarDetector.detectEnvVars({
      repositoryPath,
      framework: detectionResult.framework,
      hasDockerfile: context.rootFiles.includes('Dockerfile'),
      rootFiles: context.rootFiles,
      allFiles: context.files,
      envFileHints,
    });

    this.logger.log(
      `Env var detection complete: ${buildPlan.envVarSuggestions.candidates.length} candidate(s), isFallback=${buildPlan.envVarSuggestions.isFallback}`,
    );

    // Step 6: Inject framework-specific meta env vars
    switch (detectionResult.framework) {
      case FrameworkType.SPRING_BOOT:
        this.injectSpringProfilesActive(
          context.files,
          buildPlan.envVarSuggestions,
        );
        break;
      case FrameworkType.ASPNET_CORE:
        this.injectAspNetEnvironment(
          context.files,
          buildPlan.envVarSuggestions,
        );
        break;
      case FrameworkType.RAILS:
        this.injectRailsEnv(context.files, buildPlan.envVarSuggestions);
        break;
      case FrameworkType.DJANGO:
        this.injectDjangoSettingsModule(
          context.files,
          buildPlan.envVarSuggestions,
        );
        break;
    }

    return {
      detection: detectionResult,
      buildPlan,
      alternatives,
    };
  }

  /**
   * Run all capable detectors for a given context and return results sorted by confidence descending.
   */
  private async runAllDetectors(
    context: IDetectionContext,
  ): Promise<IDetectionResult[]> {
    const detectors = this.registry
      .getAllDetectors()
      .filter((detector) => detector.canDetect(context));

    if (detectors.length === 0) {
      return [];
    }

    const settled = await Promise.allSettled(
      detectors.map(async (detector) => {
        const metadata = detector.getMetadata();
        try {
          const result = await detector.detect(context);
          return result;
        } catch (error) {
          this.logger.error(
            `Detector ${metadata.detectorName} failed: ${error.message}`,
            error.stack,
          );
          throw error;
        }
      }),
    );

    return settled
      .filter(
        (r): r is PromiseFulfilledResult<IDetectionResult> =>
          r.status === 'fulfilled',
      )
      .map((r) => r.value)
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Detect a specific framework (when user provides framework name)
   */
  private async detectSpecificFramework(
    context: IDetectionContext,
    frameworkName: string,
  ): Promise<IDetectionResult | null> {
    // Try to map framework name to FrameworkType enum
    const frameworkType = this.mapFrameworkName(frameworkName);

    if (!frameworkType) {
      this.logger.warn(`Unknown framework name: ${frameworkName}`);
      return null;
    }

    const detector = this.registry.getDetector(frameworkType);

    if (!detector) {
      this.logger.warn(`No detector registered for: ${frameworkType}`);
      return null;
    }

    this.logger.log(`Running specific detector: ${frameworkType}`);

    try {
      const result = await detector.detect(context);
      // Boost confidence since user explicitly specified framework
      result.confidence = Math.min(100, result.confidence + 20);
      return result;
    } catch (error) {
      this.logger.error(
        `Specific detector ${frameworkType} failed: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * Prepare detection context from repository path
   */
  private async prepareContext(
    repositoryPath: string,
  ): Promise<IDetectionContext> {
    this.logger.debug(`Preparing context for: ${repositoryPath}`);

    // Get all files recursively
    const files = await this.getAllFiles(repositoryPath);
    const rootFiles = await this.getRootFiles(repositoryPath);

    // Parse package.json if exists
    const packageJson = await this.parsePackageJson(repositoryPath);

    // Parse .flui.yaml if exists
    const fluiConfig = await this.parseFluiConfig(repositoryPath);

    // Detect package manager
    const packageManager = this.detectPackageManager(rootFiles);

    // Detect lockfile
    const lockfileInfo = this.detectLockfile(rootFiles);

    // Parse .nvmrc if exists
    const nodeVersion = await this.parseNvmrc(repositoryPath);

    // Check for CI config
    const hasCIConfig = this.hasCIConfiguration(files);

    // Check for tests
    const hasTests = this.hasTestScripts(packageJson);

    return {
      repositoryPath,
      files,
      rootFiles,
      packageJson,
      fluiConfig,
      packageManager,
      lockfilePresent: lockfileInfo.present,
      lockfileName: lockfileInfo.name,
      nodeVersion,
      hasCIConfig,
      hasTests,
    };
  }

  /**
   * Get all files in repository (relative paths)
   */
  private async getAllFiles(
    dir: string,
    fileList: string[] = [],
    basePath: string = dir,
  ): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Skip node_modules, .git, etc.
      if (this.shouldSkipDirectory(entry.name)) {
        continue;
      }

      if (entry.isDirectory()) {
        await this.getAllFiles(fullPath, fileList, basePath);
      } else {
        const relativePath = path.relative(basePath, fullPath);
        fileList.push(relativePath.replaceAll('\\\\', '/'));
      }
    }

    return fileList;
  }

  /**
   * Get root-level files only
   */
  private async getRootFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.map((entry) => entry.name);
  }

  /**
   * Parse package.json if exists
   */
  private async parsePackageJson(
    dir: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const packageJsonPath = path.join(dir, 'package.json');
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return undefined;
    }
  }

  /**
   * Parse .flui.yaml if exists
   */
  private async parseFluiConfig(dir: string): Promise<IFluiConfig | undefined> {
    try {
      const fluiConfigPath = path.join(dir, '.flui.yaml');
      const raw = await fs.readFile(fluiConfigPath, 'utf-8');
      return yaml.load(raw) as IFluiConfig;
    } catch {
      return undefined;
    }
  }

  /**
   * Parse .nvmrc if exists
   */
  private async parseNvmrc(dir: string): Promise<string | undefined> {
    try {
      const nvmrcPath = path.join(dir, '.nvmrc');
      const content = await fs.readFile(nvmrcPath, 'utf-8');
      return content.trim();
    } catch {
      return undefined;
    }
  }

  /**
   * Detect package manager from lockfiles
   */
  private detectPackageManager(
    rootFiles: string[],
  ): 'npm' | 'yarn' | 'pnpm' | 'bun' | undefined {
    if (rootFiles.includes('pnpm-lock.yaml')) return 'pnpm';
    if (rootFiles.includes('yarn.lock')) return 'yarn';
    if (rootFiles.includes('bun.lockb')) return 'bun';
    if (rootFiles.includes('package-lock.json')) return 'npm';
    return undefined;
  }

  /**
   * Detect lockfile presence
   */
  private detectLockfile(rootFiles: string[]): {
    present: boolean;
    name?: string;
  } {
    const lockfiles = [
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
      'package-lock.json',
    ];

    for (const lockfile of lockfiles) {
      if (rootFiles.includes(lockfile)) {
        return { present: true, name: lockfile };
      }
    }

    return { present: false };
  }

  /**
   * Check if repository has CI configuration
   */
  private hasCIConfiguration(files: string[]): boolean {
    const ciIndicators = [
      '.github/workflows',
      '.gitlab-ci.yml',
      'circle.yml',
      '.circleci',
      'azure-pipelines.yml',
      'jenkinsfile',
    ];

    return ciIndicators.some((indicator) =>
      files.some((file) =>
        file.toLowerCase().includes(indicator.toLowerCase()),
      ),
    );
  }

  /**
   * Check if package.json has test scripts
   */
  private hasTestScripts(packageJson: Record<string, unknown>): boolean {
    if (!packageJson?.scripts) return false;
    return Object.keys(packageJson.scripts).some((script) =>
      script.toLowerCase().includes('test'),
    );
  }

  /**
   * Check if directory should be skipped
   */
  private shouldSkipDirectory(name: string): boolean {
    const skipDirs = [
      'node_modules',
      '.git',
      'dist',
      'build',
      '.next',
      'out',
      'coverage',
      '.turbo',
      '.cache',
    ];
    return skipDirs.includes(name);
  }

  /**
   * Inject SPRING_PROFILES_ACTIVE when profile-specific config files are detected.
   * Sets allowedValues for select UI and labels each candidate with its profile name.
   */
  private injectSpringProfilesActive(
    allFiles: string[],
    envVarSuggestions: {
      candidates: {
        vars: IDetectedEnvVar[];
        sourceFile: string;
        label?: string;
      }[];
      isFallback: boolean;
    },
  ): void {
    const profilePattern = /(?:^|\/)application-([^./]+)\.(properties|ya?ml)$/;
    const availableProfiles = [
      ...new Set(
        allFiles
          .filter((f) => profilePattern.test(f))
          .map((f) => profilePattern.exec(f)?.[1])
          .filter((p): p is string => !!p),
      ),
    ];

    if (availableProfiles.length === 0) return;

    // Label existing candidates that correspond to profile-specific files
    for (const candidate of envVarSuggestions.candidates) {
      const m = /application-([^./]+)\.(properties|ya?ml)$/.exec(
        candidate.sourceFile,
      );
      if (m) candidate.label = m[1];
    }

    const springProfilesVar: IDetectedEnvVar = {
      name: 'SPRING_PROFILES_ACTIVE',
      sensitive: false,
      optional: false,
      allowedValues: availableProfiles,
      description: `Activate Spring profile. Available in this repo: ${availableProfiles.join(', ')}`,
      source: EnvVarSource.FRAMEWORK_CONFIG,
    };

    this.prependEnvVar(
      springProfilesVar,
      envVarSuggestions,
      'spring-profile-detection',
    );
  }

  /**
   * Inject ASPNETCORE_ENVIRONMENT from appsettings.{env}.json files.
   */
  private injectAspNetEnvironment(
    allFiles: string[],
    envVarSuggestions: {
      candidates: {
        vars: IDetectedEnvVar[];
        sourceFile: string;
        label?: string;
      }[];
      isFallback: boolean;
    },
  ): void {
    const pattern = /(?:^|\/)appsettings\.([^.]+)\.json$/;
    const availableEnvs = [
      ...new Set(
        allFiles
          .filter((f) => pattern.test(f))
          .map((f) => pattern.exec(f)?.[1])
          .filter((e): e is string => !!e),
      ),
    ];

    if (availableEnvs.length === 0) return;

    for (const candidate of envVarSuggestions.candidates) {
      const m = /appsettings\.([^.]+)\.json$/.exec(candidate.sourceFile);
      if (m) candidate.label = m[1];
    }

    const envVar: IDetectedEnvVar = {
      name: 'ASPNETCORE_ENVIRONMENT',
      sensitive: false,
      optional: false,
      allowedValues: availableEnvs,
      description: `ASP.NET Core environment name. Available in this repo: ${availableEnvs.join(', ')}`,
      source: EnvVarSource.FRAMEWORK_CONFIG,
    };

    this.prependEnvVar(
      envVar,
      envVarSuggestions,
      'aspnetcore-environment-detection',
    );
  }

  /**
   * Inject RAILS_ENV from config/environments/*.rb files.
   */
  private injectRailsEnv(
    allFiles: string[],
    envVarSuggestions: {
      candidates: {
        vars: IDetectedEnvVar[];
        sourceFile: string;
        label?: string;
      }[];
      isFallback: boolean;
    },
  ): void {
    const pattern = /(?:^|\/)config\/environments\/([^/]+)\.rb$/;
    const availableEnvs = [
      ...new Set(
        allFiles
          .filter((f) => pattern.test(f))
          .map((f) => pattern.exec(f)?.[1])
          .filter((e): e is string => !!e),
      ),
    ];

    if (availableEnvs.length === 0) return;

    for (const candidate of envVarSuggestions.candidates) {
      const m = /config\/environments\/([^/]+)\.rb$/.exec(candidate.sourceFile);
      if (m) candidate.label = m[1];
    }

    const envVar: IDetectedEnvVar = {
      name: 'RAILS_ENV',
      sensitive: false,
      optional: false,
      allowedValues: availableEnvs,
      description: `Rails environment. Available in this repo: ${availableEnvs.join(', ')}`,
      source: EnvVarSource.FRAMEWORK_CONFIG,
    };

    this.prependEnvVar(envVar, envVarSuggestions, 'rails-env-detection');
  }

  /**
   * Inject DJANGO_SETTINGS_MODULE when settings are split into multiple files
   * (e.g. myapp/settings/production.py or settings_production.py pattern).
   */
  private injectDjangoSettingsModule(
    allFiles: string[],
    envVarSuggestions: {
      candidates: {
        vars: IDetectedEnvVar[];
        sourceFile: string;
        label?: string;
      }[];
      isFallback: boolean;
    },
  ): void {
    // Pattern 1: <pkg>/settings/<env>.py  (e.g. config/settings/production.py)
    const splitPattern = /^([^/]+)\/settings\/([^/]+)\.py$/;
    const splitMatches = allFiles
      .filter((f) => splitPattern.test(f) && !f.endsWith('__init__.py'))
      .map((f) => {
        const m = splitPattern.exec(f);
        return { module: `${m[1]}.settings.${m[2]}`, env: m[2], file: f };
      });

    // Pattern 2: settings_<env>.py in root  (e.g. settings_production.py)
    const flatPattern = /^settings_([^/]+)\.py$/;
    const flatMatches = allFiles
      .filter((f) => flatPattern.test(f))
      .map((f) => {
        const m = flatPattern.exec(f);
        return { module: `settings_${m[1]}`, env: m[1], file: f };
      });

    const allMatches = [...splitMatches, ...flatMatches];
    if (allMatches.length === 0) return;

    // Label candidates that correspond to settings files
    for (const candidate of envVarSuggestions.candidates) {
      const match = allMatches.find((m) =>
        candidate.sourceFile.endsWith(m.file),
      );
      if (match) candidate.label = match.env;
    }

    const envVar: IDetectedEnvVar = {
      name: 'DJANGO_SETTINGS_MODULE',
      sensitive: false,
      optional: false,
      allowedValues: allMatches.map((m) => m.module),
      description: `Python dotted path to Django settings module. Detected options: ${allMatches.map((m) => m.module).join(', ')}`,
      source: EnvVarSource.FRAMEWORK_CONFIG,
    };

    this.prependEnvVar(envVar, envVarSuggestions, 'django-settings-detection');
  }

  /** Prepend a meta env var to the first candidate, or create a synthetic candidate. */
  private prependEnvVar(
    envVar: IDetectedEnvVar,
    envVarSuggestions: {
      candidates: {
        vars: IDetectedEnvVar[];
        sourceFile: string;
        label?: string;
      }[];
      isFallback: boolean;
    },
    syntheticSourceFile: string,
  ): void {
    if (envVarSuggestions.candidates.length > 0) {
      envVarSuggestions.candidates[0].vars.unshift(envVar);
    } else {
      envVarSuggestions.candidates.push({
        vars: [envVar],
        sourceFile: syntheticSourceFile,
      });
      envVarSuggestions.isFallback = false;
    }
  }

  /**
   * Detect framework from a GitHub repository using the GitHub API.
   * No local clone is required — uses git tree + content fetching.
   *
   * If .flui.yaml is present with build.strategy, bypasses detection
   * and returns a pre-built advisor result with score=1.0.
   */
  async detectFromGitHub(
    octokit: Octokit,
    owner: string,
    repo: string,
    ref: string,
  ): Promise<{ detection: IDetectionResult; buildPlan: IBuildPlan } | null> {
    this.logger.log(`[detectFromGitHub] ${owner}/${repo}@${ref}`);

    try {
      // Step 0a — .flui.yaml bypass
      const fluiYamlRaw = await this.fetchGitHubFileContent(
        octokit,
        owner,
        repo,
        ref,
        '.flui.yaml',
      );
      if (fluiYamlRaw) {
        const fluiConfig = yaml.load(fluiYamlRaw) as IFluiConfig;
        if (fluiConfig?.build?.strategy) {
          this.logger.log(
            '[detectFromGitHub] .flui.yaml with build.strategy found — bypassing detection',
          );
          return this.buildFluiYamlAdvisorResult(fluiConfig);
        }
      }

      // Step 0b — FLUI-BUILD Dockerfile bypass
      const dockerfileRaw = await this.fetchGitHubFileContent(
        octokit,
        owner,
        repo,
        ref,
        'Dockerfile',
      );
      if (dockerfileRaw?.trimStart().startsWith('# FLUI-BUILD')) {
        this.logger.log(
          '[detectFromGitHub] Dockerfile with # FLUI-BUILD marker found — using directly',
        );
        return this.buildFluiDockerfileAdvisorResult(dockerfileRaw);
      }

      // Step 1 — Get full file tree via GitHub API
      const treeResp = await octokit.git.getTree({
        owner,
        repo,
        tree_sha: ref,
        recursive: '1',
      });
      if (treeResp.data.truncated) {
        this.logger.warn(
          '[detectFromGitHub] GitHub tree response was truncated — large repository',
        );
      }

      const allFiles = (treeResp.data.tree || [])
        .filter((item) => item.type === 'blob' && item.path)
        .map((item) => item.path as string);

      const rootFiles = allFiles.filter((f) => !f.includes('/'));

      // Step 2 — Fetch key files
      const packageJsonRaw = await this.fetchGitHubFileContent(
        octokit,
        owner,
        repo,
        ref,
        'package.json',
      );
      const packageJson = packageJsonRaw
        ? this.safeParse(packageJsonRaw)
        : undefined;

      const nvmrcRaw = await this.fetchGitHubFileContent(
        octokit,
        owner,
        repo,
        ref,
        '.nvmrc',
      );
      const nodeVersion = nvmrcRaw?.trim();

      // Parse .flui.yaml if present (even if no build.strategy)
      const fluiConfig = fluiYamlRaw
        ? (yaml.load(fluiYamlRaw) as IFluiConfig)
        : undefined;

      // Step 3 — Build detection context (no filesystem path)
      const packageManager = this.detectPackageManager(rootFiles);
      const lockfileInfo = this.detectLockfile(rootFiles);
      const hasCIConfig = this.hasCIConfiguration(allFiles);
      const hasTests = this.hasTestScripts(packageJson);

      const context: IDetectionContext = {
        repositoryPath: '', // sentinel — no local filesystem
        files: allFiles,
        rootFiles,
        packageJson,
        fluiConfig,
        packageManager,
        lockfilePresent: lockfileInfo.present,
        lockfileName: lockfileInfo.name,
        nodeVersion,
        hasCIConfig,
        hasTests,
      };

      // Step 4 — Run capable detectors
      const detectors = this.registry
        .getAllDetectors()
        .filter((d) => d.canDetect(context));
      if (detectors.length === 0) {
        this.logger.warn('[detectFromGitHub] No detectors matched');
        return null;
      }

      const results = await Promise.allSettled(
        detectors.map((d) => d.detect(context)),
      );
      const successful = results
        .filter(
          (r): r is PromiseFulfilledResult<IDetectionResult> =>
            r.status === 'fulfilled',
        )
        .map((r) => r.value);

      if (successful.length === 0) return null;

      // Step 5 — Select best match
      const bestMatch = this.scorer.selectBestMatch(successful);
      if (!bestMatch) return null;

      this.logger.log(
        `[detectFromGitHub] Detected: ${bestMatch.framework} (confidence=${bestMatch.confidence}%)`,
      );

      // Step 6 — Generate build plan (includes advisor fields)
      const detector = this.registry.getDetector(bestMatch.framework);
      if (!detector) return null;

      const buildPlan = await detector.generateBuildPlan(bestMatch, context);

      // Step 7 — Ensure requiresUserConfirmation is set correctly
      const AUTONOMOUS_THRESHOLD = 0.82;
      buildPlan.requiresUserConfirmation =
        buildPlan.deployabilityScore < AUTONOMOUS_THRESHOLD ||
        (buildPlan.userChoicesRequired?.length ?? 0) > 0;

      this.logger.log(
        `[detectFromGitHub] strategy=${buildPlan.deployStrategy} score=${buildPlan.deployabilityScore} requiresConfirmation=${buildPlan.requiresUserConfirmation}`,
      );

      return { detection: bestMatch, buildPlan };
    } catch (error) {
      this.logger.error(
        `[detectFromGitHub] Failed: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * Build a pre-made advisor result when a Dockerfile with # FLUI-BUILD marker is found.
   * Score is 1.0 and confirmation is never required.
   */
  private buildFluiDockerfileAdvisorResult(dockerfileContent: string): {
    detection: IDetectionResult;
    buildPlan: IBuildPlan;
  } {
    const detection: IDetectionResult = {
      framework: FrameworkType.DOCKERFILE,
      confidence: 100,
      detectorName: 'flui-dockerfile-bypass',
      metadata: { source: 'flui_dockerfile' },
    };

    const portMatch = /EXPOSE\s+(\d+)/i.exec(dockerfileContent);
    const port = portMatch ? Number.parseInt(portMatch[1], 10) : 8080;

    const buildPlan: IBuildPlan = {
      framework: FrameworkType.DOCKERFILE,
      version: 'custom',
      dockerfile: dockerfileContent,
      buildContext: '.',
      buildEnv: [],
      runtimeEnv: [],
      resources: {
        cpu: { request: '250m', limit: '1000m' },
        memory: { request: '256Mi', limit: '512Mi' },
      },
      networking: { port, protocol: 'http', ingressEnabled: true },
      metadata: {
        detectionConfidence: 100,
        templateVersion: 'flui-dockerfile',
        generatedAt: new Date(),
      },
      deployStrategy: DeployStrategy.DOCKERFILE,
      deployabilityScore: 1,
      deployabilityFactors: {
        frameworkRecognized: true,
        repoClarity: 1,
        artifactPredictability: 1,
        runtimePredictability: 1,
        buildReproducibility: 1,
      },
      projectWarnings: [],
      requiresUserConfirmation: false,
      userChoicesRequired: [],
    };

    return { detection, buildPlan };
  }

  /**
   * Build a pre-made advisor result when .flui.yaml specifies build.strategy.
   * Score is always 1.0 and confirmation is never required.
   */
  private buildFluiYamlAdvisorResult(fluiConfig: IFluiConfig): {
    detection: IDetectionResult;
    buildPlan: IBuildPlan;
  } {
    const strategyMap: Record<string, DeployStrategy> = {
      railpack_direct: DeployStrategy.RAILPACK_DIRECT,
      railpack_with_overrides: DeployStrategy.RAILPACK_WITH_OVERRIDES,
      dockerfile: DeployStrategy.DOCKERFILE,
      needs_adjustment: DeployStrategy.NEEDS_ADJUSTMENT,
    };

    const strategy: DeployStrategy =
      strategyMap[fluiConfig.build.strategy] ?? DeployStrategy.RAILPACK_DIRECT;

    const detection: IDetectionResult = {
      framework: FrameworkType.DOCKERFILE,
      confidence: 100,
      detectorName: 'flui-yaml-bypass',
      metadata: { source: 'flui_yaml' },
    };

    const buildPlan: IBuildPlan = {
      framework: FrameworkType.DOCKERFILE,
      version: 'custom',
      dockerfile: '',
      buildContext: '.',
      buildEnv: fluiConfig.build?.env ?? [],
      runtimeEnv: fluiConfig.runtime?.env ?? [],
      resources: {
        cpu: { request: '250m', limit: '1000m' },
        memory: { request: '256Mi', limit: '512Mi' },
      },
      networking: {
        port: fluiConfig.runtime?.port ?? 8080,
        protocol: 'http',
        ingressEnabled: true,
      },
      metadata: {
        detectionConfidence: 100,
        templateVersion: 'flui-yaml',
        generatedAt: new Date(),
      },
      deployStrategy: strategy,
      deployabilityScore: 1,
      deployabilityFactors: {
        frameworkRecognized: true,
        repoClarity: 1,
        artifactPredictability: 1,
        runtimePredictability: 1,
        buildReproducibility: 1,
      },
      suggestedBuildCommand: fluiConfig.build?.buildCommand,
      suggestedStartCommand: fluiConfig.build?.startCommand,
      projectWarnings: [],
      requiresUserConfirmation: false,
      userChoicesRequired: [],
    };

    return { detection, buildPlan };
  }

  /**
   * Fetch a single file from GitHub and return its decoded content, or null.
   */
  private async fetchGitHubFileContent(
    octokit: Octokit,
    owner: string,
    repo: string,
    ref: string,
    filePath: string,
  ): Promise<string | null> {
    try {
      const resp = await octokit.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref,
      });
      const data = resp.data as { encoding?: string; content?: string };
      if (data.encoding === 'base64' && data.content) {
        return Buffer.from(
          data.content.replaceAll('\n', ''),
          'base64',
        ).toString('utf-8');
      }
      return null;
    } catch {
      return null;
    }
  }

  private safeParse(raw: string): Record<string, unknown> | undefined {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  /**
   * Map user-provided framework name to FrameworkType enum
   */
  private mapFrameworkName(name: string): FrameworkType | null {
    const mapping: Record<string, FrameworkType> = {
      dockerfile: FrameworkType.DOCKERFILE,
      nextjs: FrameworkType.NEXTJS,
      'next.js': FrameworkType.NEXTJS,
      next: FrameworkType.NEXTJS,
      angular: FrameworkType.ANGULAR,
      nestjs: FrameworkType.NESTJS,
      'nest.js': FrameworkType.NESTJS,
      nest: FrameworkType.NESTJS,
      'react-vite': FrameworkType.REACT_VITE,
      react: FrameworkType.REACT_VITE,
      express: FrameworkType.EXPRESS,
      'express.js': FrameworkType.EXPRESS,
      'vue-vite': FrameworkType.VUE_VITE,
      vue: FrameworkType.VUE_VITE,
      nuxt: FrameworkType.NUXT,
      'nuxt.js': FrameworkType.NUXT,
      svelte: FrameworkType.SVELTE_KIT,
      sveltekit: FrameworkType.SVELTE_KIT,
      static: FrameworkType.STATIC_HTML,
      html: FrameworkType.STATIC_HTML,
    };

    return mapping[name.toLowerCase()] || null;
  }
}
