/**
 * The tree reader: given a repository the validation path already has in
 * hand (owner, repo, ref) and the caller's own GitHub credential, produces
 * the `RepoScan` cartographer's detectors read — one API round trip, no
 * clone, nothing written to disk.
 *
 * `GitHubTokenResolverService.getOctokit` is the same credential resolver
 * `RepositoriesService.getFluiManifests` already uses for a tree listing; this
 * asks for the whole commit instead, as one `.tar.gz`. The ref is resolved to
 * a commit SHA first — every fact a later reader states is true of that SHA
 * and no other tree — then the archive for that SHA is fetched and handed to
 * `scanArchive`, which does the decoding and the ceilings. The whole
 * operation — resolving the ref, downloading, decoding — runs under one wall
 * clock (`limits.timeoutMs`): a validation runs with a person waiting.
 *
 * This module stops at handing back a `RepoScan`. Turning what cartographer
 * reports into `RepoFacts` — the shape the manifest checks compare against —
 * is `repo-facts.core.ts`, and `RepoFactsReaderService` is what joins the
 * two.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { RepoScan } from '@flui-cloud/cartographer';
import { GitHubTokenResolverService } from '../../repositories/services/github-token-resolver.service';
import {
  scanArchive,
  DEFAULT_REPO_SNAPSHOT_LIMITS,
  type ArchiveRejectReason,
} from './repo-archive-scan.util';
import type { RepoSnapshotLimits } from '../interfaces/repo-snapshot.interface';

/** Why no `RepoScan` came back. A superset of `ArchiveRejectReason`: the two
 * extra reasons are about reaching the repository at all, before any byte of
 * it is read. */
export type RepoTreeUnreadReason =
  | ArchiveRejectReason
  | 'no-credential'
  | 'not-found';

export interface RepoTreeRead {
  read: true;
  /** The commit every fact `scan` can produce is true of, and of no other tree. */
  commitSha: string;
  ref: string;
  scan: RepoScan;
  truncated: boolean;
  contentComplete: boolean;
  skipped: { symlinks: number; oversize: number; other: number };
  /** Decompressed content retained, in bytes. */
  bytesRead: number;
  /** High-density paths the content ceiling cut. See `RepoSnapshot.highDensityUnread`. */
  highDensityUnread: string[];
}

export interface RepoTreeUnread {
  read: false;
  reason: RepoTreeUnreadReason;
  repoFullName: string;
  ref: string;
}

export type RepoTreeReadResult = RepoTreeRead | RepoTreeUnread;

type Octokit = Awaited<ReturnType<GitHubTokenResolverService['getOctokit']>>;

const TIMEOUT = Symbol('repo-tree-reader:timeout');

@Injectable()
export class RepoTreeReaderService {
  private readonly logger = new Logger(RepoTreeReaderService.name);

  constructor(private readonly tokenResolver: GitHubTokenResolverService) {}

  async readTree(
    userId: string,
    owner: string,
    repo: string,
    ref: string,
    limits: RepoSnapshotLimits = DEFAULT_REPO_SNAPSHOT_LIMITS,
  ): Promise<RepoTreeReadResult> {
    const repoFullName = `${owner}/${repo}`;
    const timed = await withTimeout(
      this.readTreeUntimed(userId, owner, repo, ref, repoFullName, limits),
      limits.timeoutMs,
    );
    if (timed === TIMEOUT) {
      return { read: false, reason: 'unreadable', repoFullName, ref };
    }
    return timed;
  }

  private async readTreeUntimed(
    userId: string,
    owner: string,
    repo: string,
    ref: string,
    repoFullName: string,
    limits: RepoSnapshotLimits,
  ): Promise<RepoTreeReadResult> {
    const unread = (reason: RepoTreeUnreadReason): RepoTreeUnread => ({
      read: false,
      reason,
      repoFullName,
      ref,
    });

    let octokit: Octokit;
    try {
      octokit = await this.tokenResolver.getOctokit(userId, owner);
    } catch (error) {
      this.logger.warn(`No GitHub credential for ${owner}: ${error.message}`);
      return unread('no-credential');
    }

    const commit = await this.resolveCommitSha(octokit, owner, repo, ref);
    if (commit.ok === false) return unread(commit.reason);

    const archive = await this.downloadArchive(
      octokit,
      owner,
      repo,
      commit.sha,
    );
    if (archive.ok === false) return unread(archive.reason);

    const scanned = await scanArchive(archive.bytes, limits);
    if (scanned.ok === false) return unread(scanned.reason);

    const snapshot = scanned.snapshot;
    const scan: RepoScan = {
      root: repoFullName,
      files: snapshot.files,
      truncated: snapshot.truncated,
      read: snapshot.read,
      sources: snapshot.sources,
    };
    return {
      read: true,
      commitSha: commit.sha,
      ref,
      scan,
      truncated: snapshot.truncated,
      contentComplete: snapshot.contentComplete,
      skipped: snapshot.skipped,
      bytesRead: snapshot.bytesRead,
      highDensityUnread: snapshot.highDensityUnread,
    };
  }

  private async resolveCommitSha(
    octokit: Octokit,
    owner: string,
    repo: string,
    ref: string,
  ): Promise<
    | { ok: true; sha: string }
    | { ok: false; reason: 'not-found' | 'unreadable' }
  > {
    try {
      const { data } = await octokit.repos.getCommit({ owner, repo, ref });
      return { ok: true, sha: data.sha };
    } catch (error) {
      if (error?.status === 404) return { ok: false, reason: 'not-found' };
      this.logger.warn(
        `Could not resolve ${owner}/${repo}@${ref}: ${error.message}`,
      );
      return { ok: false, reason: 'unreadable' };
    }
  }

  private async downloadArchive(
    octokit: Octokit,
    owner: string,
    repo: string,
    commitSha: string,
  ): Promise<
    | { ok: true; bytes: Buffer }
    | { ok: false; reason: 'not-found' | 'unreadable' }
  > {
    try {
      const response = await octokit.repos.downloadTarballArchive({
        owner,
        repo,
        ref: commitSha,
      });
      return { ok: true, bytes: Buffer.from(response.data as ArrayBuffer) };
    } catch (error) {
      if (error?.status === 404) return { ok: false, reason: 'not-found' };
      this.logger.warn(
        `Could not download archive for ${owner}/${repo}@${commitSha}: ${error.message}`,
      );
      return { ok: false, reason: 'unreadable' };
    }
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMEOUT> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(TIMEOUT);
      },
    );
  });
}
