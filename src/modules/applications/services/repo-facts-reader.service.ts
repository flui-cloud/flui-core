/**
 * What the deploy path calls to have a repository read: fetch the commit, hand
 * it to the survey, hand back the facts the manifest checks compare against.
 *
 * The one rule of this file: **a failure to read is an answer, not an
 * exception.** `factsFor` never throws. A repository that could not be reached,
 * decoded or surveyed comes back as `read: false` with a reason, which yields
 * exactly one `unknown` check — because a validation that fails because we
 * could not look is the outcome this whole family exists to prevent.
 *
 * The mapping itself is `repo-facts.core.ts`, which knows nothing about the
 * network.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  RepoTreeReaderService,
  type RepoTreeUnreadReason,
} from './repo-tree-reader.service';
import { DEFAULT_REPO_SNAPSHOT_LIMITS } from './repo-archive-scan.util';
import type {
  RepoFactsReader,
  RepoRef,
  RepoSnapshotLimits,
} from '../interfaces/repo-snapshot.interface';
import type { RepoFacts, RepoUnreadReason } from '../manifest-repo-checks.core';
import { repoFactsFrom } from '../repo-facts.core';

/** Every reason the tree reader has is also a reason this family names; the one
 * it does not produce (`not-connected`) is decided before a read is attempted. */
const UNREAD_REASON: Record<RepoTreeUnreadReason, RepoUnreadReason> = {
  'no-credential': 'no-credential',
  'not-found': 'not-found',
  'too-large': 'too-large',
  unreadable: 'unreadable',
  rejected: 'rejected',
};

@Injectable()
export class RepoFactsReaderService implements RepoFactsReader {
  private readonly logger = new Logger(RepoFactsReaderService.name);

  constructor(private readonly treeReader: RepoTreeReaderService) {}

  async factsFor(
    userId: string,
    ref: RepoRef,
    limits?: Partial<RepoSnapshotLimits>,
  ): Promise<RepoFacts> {
    const repoFullName = `${ref.owner}/${ref.repo}`;
    let tree: Awaited<ReturnType<RepoTreeReaderService['readTree']>>;
    try {
      tree = await this.treeReader.readTree(
        userId,
        ref.owner,
        ref.repo,
        ref.ref,
        {
          ...DEFAULT_REPO_SNAPSHOT_LIMITS,
          ...limits,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Could not read ${repoFullName}@${ref.ref}: ${error?.message}`,
      );
      return { read: false, reason: 'unreadable', repoFullName, ref: ref.ref };
    }

    if (tree.read === false) {
      return {
        read: false,
        reason: UNREAD_REASON[tree.reason] ?? 'unreadable',
        repoFullName: tree.repoFullName,
        ref: tree.ref,
      };
    }

    try {
      return repoFactsFrom(tree);
    } catch (error) {
      // A survey that threw read nothing usable: saying so is an answer, and
      // letting it escape would fail a validation over our own defect.
      this.logger.warn(
        `Could not survey ${repoFullName}@${ref.ref}: ${error?.message}`,
      );
      return { read: false, reason: 'unreadable', repoFullName, ref: tree.ref };
    }
  }
}
