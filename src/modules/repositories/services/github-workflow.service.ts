import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
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

/** One file in a multi-file commit: repo-root-relative path, whole content. */
export interface CommitFile {
  path: string;
  content: string;
}

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
   * Cuts a new branch **at a commit the caller names**, with no commit on it.
   *
   * This is the first thing the apply writes, and it is deliberately the least
   * damaging write there is: the new ref points exactly where that commit
   * already is, so no file changed, no workflow matched, no Actions minute was
   * spent. If the credential cannot write to this repository we find out here,
   * before an Application row exists and before anything was committed.
   *
   * `baseSha`, not a branch name, and that is the whole point. Resolving the
   * branch tip here would resolve it a second time — the map already read one,
   * rendered every manifest from it, and named the branch after it. If the
   * author pushes between the two reads, the manifests rendered from commit A
   * land on top of commit B while the branch is called `deploy-<A7>` and the
   * response says `baseCommitSha: A`: two statements that are simply not true.
   * Taking the sha means the branch is the commit the map read, or nothing.
   *
   * It is also the lock. GitHub answers 422 when the ref exists, and that
   * answer is the whole concurrency story: two applies from the same commit
   * cannot both proceed, and the second one is told which branch already
   * holds the first one's work rather than silently pushing a second commit
   * onto it — a second commit would re-trigger every build on that branch.
   */
  async createBranchFrom(
    userId: string,
    owner: string,
    repo: string,
    head: string,
    baseSha: string,
  ): Promise<{ head: string; baseSha: string }> {
    if (!baseSha) {
      throw new BadRequestException(
        `Refusing to cut ${head} in ${owner}/${repo}: no base commit was given. ` +
          'A Flui branch is cut at the exact commit its manifests were rendered from, ' +
          'never at whatever the branch happens to point at now.',
      );
    }
    await this.tokenResolver.assertCapability(userId, ['repo', 'workflow']);
    const octokit = await this.tokenResolver.getOctokit(userId, owner);

    try {
      await octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${head}`,
        sha: baseSha,
      });
    } catch (error) {
      const status = (error as { status?: number })?.status;
      if (status === 422) {
        throw new ConflictException(
          `The branch ${head} already exists in ${owner}/${repo}. ` +
            'It holds an earlier apply from this same commit. Open it to see how that one finished, ' +
            'or push a new commit to your branch and apply again from there.',
        );
      }
      if (status === 403 || status === 404) {
        throw new ForbiddenException(
          `Flui cannot create a branch in ${owner}/${repo}. The connected GitHub credential has no write access to it, ` +
            'so nothing was written. Grant it write access — or fork the repository into your own namespace — and try again.',
        );
      }
      throw error;
    }

    this.logger.log(
      `Cut ${owner}/${repo}@${head} at ${baseSha.slice(0, 7)} — no commit yet`,
    );
    return { head, baseSha };
  }

  /**
   * One commit, N files, one tree — on a branch Flui owns.
   *
   * The atomicity is the point: N manifests and N workflows arriving as N
   * commits would fire N rounds of builds, each round rebuilding whatever the
   * previous commit had already queued. One tree means one push event, and a
   * push event is what the generated workflows trigger on.
   *
   * `branch` is expected to be a branch Flui cut itself (`createBranchFrom`),
   * which is why this advances the ref outright: nothing here is a decision
   * about somebody's own branch. Pointing it at a user branch would be, and
   * that path is `commitWorkflowOnly` with its delivery choice.
   */
  async commitFilesOnBranch(
    userId: string,
    owner: string,
    repo: string,
    branch: string,
    files: CommitFile[],
    opts: { message: string },
  ): Promise<CommitResult & { baseSha: string; files: string[] }> {
    if (files.length === 0) {
      throw new BadRequestException(
        'Refusing to create an empty commit: no files were rendered.',
      );
    }
    await this.tokenResolver.assertCapability(userId, ['repo', 'workflow']);
    const octokit = await this.tokenResolver.getOctokit(userId, owner);

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

    const { data: treeData } = await octokit.git.createTree({
      owner,
      repo,
      base_tree: commitData.tree.sha,
      tree: files.map((file) => ({
        path: file.path,
        mode: '100644' as const,
        type: 'blob' as const,
        content: file.content,
      })),
    });

    const { data: newCommit } = await octokit.git.createCommit({
      owner,
      repo,
      message: opts.message,
      tree: treeData.sha,
      parents: [latestCommitSha],
    });

    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommit.sha,
    });

    this.logger.log(
      `Committed ${files.length} file(s) to ${owner}/${repo}@${branch} (${newCommit.sha.slice(0, 7)})`,
    );

    return {
      workflowUrl: `https://github.com/${owner}/${repo}/tree/${branch}`,
      sha: newCommit.sha,
      baseSha: latestCommitSha,
      files: files.map((f) => f.path),
    };
  }

  /**
   * Removes a branch Flui cut. Best-effort by construction: it runs on the
   * failure path of an apply, where the error the caller is about to raise is
   * the one that matters, and a leftover empty branch is a nuisance rather
   * than a hazard.
   */
  async deleteBranch(
    userId: string,
    owner: string,
    repo: string,
    head: string,
  ): Promise<boolean> {
    try {
      const octokit = await this.tokenResolver.getOctokit(userId, owner);
      await octokit.git.deleteRef({ owner, repo, ref: `heads/${head}` });
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not delete ${owner}/${repo}@${head}: ${(error as Error)?.message}`,
      );
      return false;
    }
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
      return Buffer.from(encoded.replaceAll('\n', ''), 'base64').toString(
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
