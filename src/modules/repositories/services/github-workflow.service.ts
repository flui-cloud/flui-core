import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as sodium from 'libsodium-wrappers';
import { GitHubOAuthService } from './github-oauth.service';
import { GitHubTokenResolverService } from './github-token-resolver.service';

export interface CommitResult {
  workflowUrl: string;
  sha: string;
  /** Set when the change was proposed rather than pushed. */
  pullRequestUrl?: string;
}

/**
 * Where the workflow commit lands.
 *
 * `push` writes to the branch, which is right when someone connected their own
 * repository to their own Flui and expects it to just work. `pull-request`
 * proposes instead, which is the only defensible option when a stranger clicks
 * a button on a demo: accepting our pull request is consent, whereas writing to
 * their default branch is an intrusion however loudly it was announced.
 */
export type WorkflowDelivery = 'push' | 'pull-request';

/** Legacy shared workflow path (single-app repos, pre multi-app). */
export const LEGACY_WORKFLOW_PATH = '.github/workflows/flui.yml';

/**
 * Per-app workflow filename. One workflow per Application so a monorepo can
 * host several source-built apps on the same branch.
 */
export function fluiWorkflowFileName(appSlug: string): string {
  return `flui-${appSlug}.yml`;
}

/** True when a workflow run belongs to a Flui-generated workflow (any app). */
export function isFluiWorkflowRun(run: {
  path?: string | null;
  name?: string | null;
}): boolean {
  return (
    /\/flui[^/]*\.ya?ml$/.test(run.path ?? '') ||
    (run.name ?? '').startsWith('Flui Deploy')
  );
}

export interface WorkflowRunStatus {
  runId: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'cancelled' | null;
  url: string;
  /**
   * Full commit SHA (40 chars) that the workflow ran on. Populated from
   * GitHub's `run.head_sha`. Consumers that need to derive a deterministic
   * imageRef (e.g. the build watcher) should use `headSha.slice(0, 7)`.
   */
  headSha: string;
  runStartedAt: Date | null;
  updatedAt: Date | null;
}

/**
 * Commits GitHub Actions workflow files to a user's repository
 * and polls workflow run status via the GitHub Contents & Actions APIs.
 */
@Injectable()
export class GitHubWorkflowService {
  private readonly logger = new Logger(GitHubWorkflowService.name);

  constructor(
    private readonly githubOAuthService: GitHubOAuthService,
    private readonly tokenResolver: GitHubTokenResolverService,
  ) {}

  /**
   * Atomically commit .github/workflows/flui.yml and optionally Dockerfile in a single commit
   * using the Git Data API. A single commit means a single workflow trigger.
   * Skips Dockerfile if it already contains '#flui-managed'.
   */
  async commitWorkflowFiles(
    userId: string,
    owner: string,
    repo: string,
    branch: string,
    workflowYaml: string,
    dockerfile?: string,
    delivery: WorkflowDelivery = 'push',
  ): Promise<CommitResult> {
    await this.tokenResolver.assertCapability(userId, ['repo', 'workflow']);

    const octokit = await this.tokenResolver.getOctokit(userId, owner);

    // 1. Get current branch tip
    const { data: refData } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
    });
    const latestCommitSha = refData.object.sha;

    // 2. Get base tree SHA from the latest commit
    const { data: commitData } = await octokit.git.getCommit({
      owner,
      repo,
      commit_sha: latestCommitSha,
    });
    const baseTreeSha = commitData.tree.sha;

    // 3. Build tree items — always include the workflow file
    const treeItems: Array<{
      path: string;
      mode: '100644';
      type: 'blob';
      content: string;
    }> = [
      {
        path: '.github/workflows/flui.yml',
        mode: '100644',
        type: 'blob',
        content: workflowYaml,
      },
    ];

    // Include Dockerfile only if provided and repo doesn't have a #flui-managed one already
    if (dockerfile) {
      const existingContent = await this.getFileContent(
        octokit,
        owner,
        repo,
        branch,
        'Dockerfile',
      );
      if (!existingContent?.includes('#flui-managed')) {
        treeItems.push({
          path: 'Dockerfile',
          mode: '100644',
          type: 'blob',
          content: `# #flui-managed\n${dockerfile}`,
        });
      }
    }

    // 4. Create new tree on top of the base tree
    const { data: treeData } = await octokit.git.createTree({
      owner,
      repo,
      base_tree: baseTreeSha,
      tree: treeItems,
    });

    // 5. Create commit pointing to the new tree
    const { data: newCommit } = await octokit.git.createCommit({
      owner,
      repo,
      message: 'chore: add Flui deployment workflow',
      tree: treeData.sha,
      parents: [latestCommitSha],
    });

    // 6. Deliver: advance the branch, or put the commit on a branch of our own
    //    and ask for it to be merged.
    this.logger.log(
      `Prepared ${treeItems.length} file(s) for ${owner}/${repo}@${branch} (${newCommit.sha.slice(0, 7)})`,
    );
    return this.landCommit(
      octokit,
      owner,
      repo,
      branch,
      newCommit.sha,
      LEGACY_WORKFLOW_PATH,
      delivery,
    );
  }

  /**
   * The last step of every workflow commit: either the branch moves, or it does
   * not move and we ask instead.
   *
   * One implementation on purpose. The two entry points above drifted for a
   * while — one could propose, the other could only push — and the one that
   * could only push is the one the product actually calls, so the ability to
   * propose existed in the codebase and nowhere in the product.
   */
  private async landCommit(
    octokit: Awaited<ReturnType<GitHubTokenResolverService['getOctokit']>>,
    owner: string,
    repo: string,
    branch: string,
    commitSha: string,
    workflowPath: string,
    delivery: WorkflowDelivery,
  ): Promise<CommitResult> {
    if (delivery === 'pull-request') {
      const head = `flui/deploy-workflow-${commitSha.slice(0, 7)}`;
      await octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${head}`,
        sha: commitSha,
      });
      const { data: pr } = await octokit.pulls.create({
        owner,
        repo,
        base: branch,
        head,
        title: 'Add the Flui deployment workflow',
        body:
          'Flui opened this instead of pushing to your branch.\n\n' +
          `It adds \`${workflowPath}\`. Merging it lets GitHub Actions build this repository on GitHub-hosted runners and publish the image to your own ghcr.io. ` +
          'Your code is never built on Flui machines — Flui only runs the resulting image.\n\n' +
          '**The build uses your Actions minutes.** Close this pull request and nothing happens.',
      });

      this.logger.log(
        `Proposed the workflow to ${owner}/${repo} as PR #${pr.number}`,
      );
      return {
        workflowUrl: `https://github.com/${owner}/${repo}/blob/${head}/${workflowPath}`,
        sha: commitSha,
        pullRequestUrl: pr.html_url,
      };
    }

    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: commitSha,
    });

    return {
      workflowUrl: `https://github.com/${owner}/${repo}/blob/${branch}/${workflowPath}`,
      sha: commitSha,
    };
  }

  /**
   * V3: Commits only the workflow file (no Dockerfile).
   *
   * The commit message must NOT contain `[skip ci]`: in V3 the workflow trigger
   * is `on: push: branches: [main]`, so the very commit that adds the workflow
   * is what kicks off the first run. Adding `[skip ci]` would silently swallow
   * the first build and the application would never get a workflowRunId.
   *
   * When the app migrates from the legacy shared `flui.yml` to its per-app
   * file, the legacy file is deleted in the same atomic commit — but only if
   * it belongs to this app (contains its FLUI_APP_ID), so sibling apps in a
   * monorepo keep their workflow untouched.
   */
  async commitWorkflowOnly(
    userId: string,
    owner: string,
    repo: string,
    branch: string,
    workflowYaml: string,
    opts?: {
      workflowFileName?: string;
      cleanupLegacyForAppId?: string;
      delivery?: WorkflowDelivery;
    },
  ): Promise<CommitResult> {
    await this.tokenResolver.assertCapability(userId, ['repo', 'workflow']);

    const octokit = await this.tokenResolver.getOctokit(userId, owner);
    const workflowPath = opts?.workflowFileName
      ? `.github/workflows/${opts.workflowFileName}`
      : LEGACY_WORKFLOW_PATH;

    const { data: refData } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
    });
    const latestCommitSha = refData.object.sha;

    const { data: commitData } = await octokit.git.getCommit({
      owner,
      repo,
      commit_sha: latestCommitSha,
    });
    const baseTreeSha = commitData.tree.sha;

    const tree: Array<{
      path: string;
      mode: '100644';
      type: 'blob';
      content?: string;
      sha?: string | null;
    }> = [
      {
        path: workflowPath,
        mode: '100644',
        type: 'blob',
        content: workflowYaml,
      },
    ];

    if (
      opts?.cleanupLegacyForAppId &&
      workflowPath !== LEGACY_WORKFLOW_PATH &&
      (await this.legacyWorkflowBelongsToApp(
        octokit,
        owner,
        repo,
        branch,
        opts.cleanupLegacyForAppId,
      ))
    ) {
      tree.push({
        path: LEGACY_WORKFLOW_PATH,
        mode: '100644',
        type: 'blob',
        sha: null,
      });
      this.logger.log(
        `Removing superseded legacy ${LEGACY_WORKFLOW_PATH} (app ${opts.cleanupLegacyForAppId}) in the same commit`,
      );
    }

    const { data: treeData } = await octokit.git.createTree({
      owner,
      repo,
      base_tree: baseTreeSha,
      tree: tree as any,
    });

    const { data: newCommit } = await octokit.git.createCommit({
      owner,
      repo,
      message: 'chore: add Flui deployment workflow',
      tree: treeData.sha,
      parents: [latestCommitSha],
    });

    this.logger.log(
      `V3 workflow prepared for ${owner}/${repo}@${branch} at ${workflowPath} (${newCommit.sha.slice(0, 7)})`,
    );

    return this.landCommit(
      octokit,
      owner,
      repo,
      branch,
      newCommit.sha,
      workflowPath,
      opts?.delivery ?? 'push',
    );
  }

  /**
   * True when the legacy shared flui.yml exists on the branch AND was generated
   * for the given app (its FLUI_APP_ID env matches). Any read failure = false:
   * cleanup is best-effort and must never block the workflow commit.
   */
  private async legacyWorkflowBelongsToApp(
    octokit: Awaited<ReturnType<GitHubTokenResolverService['getOctokit']>>,
    owner: string,
    repo: string,
    branch: string,
    appId: string,
  ): Promise<boolean> {
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: LEGACY_WORKFLOW_PATH,
        ref: branch,
      });
      const file = data as { encoding?: string; content?: string };
      if (file.encoding !== 'base64' || !file.content) return false;
      const content = Buffer.from(file.content, 'base64').toString('utf-8');
      return content.includes(`FLUI_APP_ID: ${appId}`);
    } catch {
      return false;
    }
  }

  /**
   * Get the latest Flui workflow run on a given branch.
   *
   * When `workflowFileName` is given (per-app workflow), the run for that exact
   * file wins; a legacy shared `flui.yml` run is accepted as fallback so apps
   * committed before the per-app split keep resolving. Without a filename, any
   * Flui-generated workflow run matches (ambiguous in monorepos — callers that
   * know the app should pass the filename).
   */
  async getLatestWorkflowRun(
    userId: string,
    owner: string,
    repo: string,
    branch: string,
    headSha?: string,
    workflowFileName?: string,
  ): Promise<WorkflowRunStatus | null> {
    const octokit = await this.tokenResolver.getOctokit(userId, owner);

    try {
      const { data } = await octokit.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        branch,
        per_page: 10,
        ...(headSha ? { head_sha: headSha } : {}),
      });

      const runs = data.workflow_runs;
      const exact = workflowFileName
        ? runs.find((run) => run.path?.endsWith(`/${workflowFileName}`))
        : undefined;
      const fluiRun =
        exact ??
        runs.find((run) =>
          workflowFileName
            ? run.path?.endsWith(`/flui.yml`)
            : isFluiWorkflowRun(run),
        );

      if (!fluiRun) return null;

      return this.mapRunStatus(fluiRun);
    } catch (error) {
      this.logger.warn(`Could not fetch workflow runs: ${error.message}`);
      return null;
    }
  }

  /**
   * Get status of a specific workflow run by run ID.
   */
  async getWorkflowRunStatus(
    userId: string,
    owner: string,
    repo: string,
    runId: string,
  ): Promise<WorkflowRunStatus> {
    const octokit = await this.tokenResolver.getOctokit(userId, owner);

    try {
      const { data } = await octokit.actions.getWorkflowRun({
        owner,
        repo,
        run_id: Number.parseInt(runId, 10),
      });

      return this.mapRunStatus(data);
    } catch (error) {
      throw new BadRequestException(
        `Could not fetch workflow run ${runId}: ${error.message}`,
      );
    }
  }

  async getUserAccessToken(userId: string, owner?: string): Promise<string> {
    if (owner) {
      return this.tokenResolver.getAccessToken(userId, owner);
    }
    return this.githubOAuthService.getAccessToken(userId);
  }

  /**
   * Encrypt and save a GitHub Actions secret in the user's repo.
   * The secret value is encrypted with the repo's public key using libsodium
   * before being sent to the GitHub API.
   */
  async saveRepoSecret(
    userId: string,
    owner: string,
    repo: string,
    secretName: string,
    secretValue: string,
  ): Promise<void> {
    const octokit = await this.tokenResolver.getOctokit(userId, owner);

    const { data: keyData } = await octokit.actions.getRepoPublicKey({
      owner,
      repo,
    });

    await sodium.ready;
    const keyBytes = Buffer.from(keyData.key, 'base64');
    const valueBytes = Buffer.from(secretValue);
    const encryptedBytes = sodium.crypto_box_seal(valueBytes, keyBytes);
    const encryptedValue = Buffer.from(encryptedBytes).toString('base64');

    await octokit.actions.createOrUpdateRepoSecret({
      owner,
      repo,
      secret_name: secretName,
      encrypted_value: encryptedValue,
      key_id: keyData.key_id,
    });

    this.logger.log(`Saved secret ${secretName} to ${owner}/${repo}`);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async getFileContent(
    octokit: any,
    owner: string,
    repo: string,
    branch: string,
    filePath: string,
  ): Promise<string | null> {
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: branch,
      });
      const encoded = data.content as string;
      return Buffer.from(encoded.replaceAll('n', ''), 'base64').toString(
        'utf-8',
      );
    } catch {
      return null;
    }
  }

  private mapRunStatus(run: any): WorkflowRunStatus {
    const parseDate = (v: unknown): Date | null => {
      if (!v || typeof v !== 'string') return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    return {
      runId: String(run.id),
      status: run.status as 'queued' | 'in_progress' | 'completed',
      conclusion: run.conclusion as 'success' | 'failure' | 'cancelled' | null,
      url: run.html_url,
      headSha: run.head_sha ?? '',
      runStartedAt: parseDate(run.run_started_at) ?? parseDate(run.created_at),
      updatedAt: parseDate(run.updated_at),
    };
  }
}
