import { createHash } from 'node:crypto';
import { PlatformReleaseEntry } from '../interfaces/release-manifest.interface';
import { byBytes } from './manifest-documents.util';
import {
  UpgradePhaseKey,
  UpgradePlanBlocker,
  UpgradePlanFile,
  UpgradePlanPhase,
  WITHOUT_BACKUP_ACKNOWLEDGEMENT,
} from '../interfaces/platform-upgrade.interface';
import {
  K3sVersion,
  compareK3sVersions,
  parseK3sVersion,
} from './k3s-path.util';
import {
  K3S_CONTROLLER_WAIT_MS,
  K3S_STEP_BASE_MS,
  K3S_STEP_PER_NODE_MS,
} from './k3s-plans.util';

export const PHASE_ORDER: UpgradePhaseKey[] = [
  'backup',
  'manifests',
  'images',
  'k3s',
  'verify',
];

export const PHASE_TITLE: Record<UpgradePhaseKey, string> = {
  backup: 'Back up the platform',
  manifests: 'Bring the system manifests forward',
  images: 'Roll out the platform components',
  k3s: 'Upgrade K3s',
  verify: 'Verify',
};

const MINUTE = 60_000;

const controlFirst = (t: 'control' | 'workload') => (t === 'control' ? 0 : 1);

/** Control first: it is the one that refreshes the others. */
export function manifestOrder<
  T extends { clusterType: 'control' | 'workload' },
>(clusters: T[]): T[] {
  return clusters
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) =>
        controlFirst(a.c.clusterType) - controlFirst(b.c.clusterType) ||
        a.i - b.i,
    )
    .map(({ c }) => c);
}

/** Workload clusters first, the control last: it stays able to manage the others. */
export function k3sOrder<T extends { clusterType: 'control' | 'workload' }>(
  clusters: T[],
): T[] {
  return clusters
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) =>
        controlFirst(b.c.clusterType) - controlFirst(a.c.clusterType) ||
        a.i - b.i,
    )
    .map(({ c }) => c);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort(byBytes)
      .reduce<Record<string, unknown>>((out, key) => {
        const v = (value as Record<string, unknown>)[key];
        if (v !== undefined) out[key] = canonical(v);
        return out;
      }, {});
  }
  return value;
}

export interface DigestInput {
  targetVersion: string;
  bootstrapRef: string;
  k3sVersion: string | null;
  phases: UpgradePlanPhase[];
  blockers: UpgradePlanBlocker[];
}

export function upgradeDigest(input: DigestInput): string {
  const body = JSON.stringify(
    canonical({
      targetVersion: input.targetVersion,
      bootstrapRef: input.bootstrapRef,
      k3sVersion: input.k3sVersion,
      phases: input.phases,
      blockers: input.blockers,
    }),
  );
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

/**
 * What a release asks of an installation besides new images. Empty means the
 * image-only path may still apply it the way it always has.
 */
export function nonImageReasons(
  release: PlatformReleaseEntry,
  observedK3s: Array<string | null | undefined>,
): string[] {
  const reasons: string[] = [];
  const target = parseK3sVersion(release.k3s?.version);
  const observed = observedK3s.map((v) => parseK3sVersion(v));
  const behind =
    observed.length === 0 ||
    observed.some(
      (v: K3sVersion | null) =>
        !v || (target !== null && compareK3sVersions(target, v) > 0),
    );
  if (target && behind) {
    reasons.push(`it upgrades K3s to ${release.k3s?.version}`);
  }
  if (release.manifestSets?.length) {
    reasons.push(
      `it changes the system manifests (${release.manifestSets.join(', ')})`,
    );
  } else if (release.requiresBootstrap) {
    reasons.push('it changes the bootstrap manifests');
  }
  return reasons;
}

/** The files a manifest refresh plan would write. */
export function writableFiles(
  entries: Array<{ name: string; action: string; releaseSha?: string }>,
): UpgradePlanFile[] {
  return entries
    .filter((e) => e.action === 'replace' || e.action === 'add')
    .map((e) => ({
      name: e.name,
      action: e.action as 'replace' | 'add',
      releaseSha: e.releaseSha,
    }));
}

/** Every file about to be written was previewed, with the same content. */
export function approvalCovers(
  approved: UpgradePlanFile[],
  fresh: UpgradePlanFile[],
): boolean {
  const seen = new Map(approved.map((f) => [f.name, f]));
  return fresh.every((f) => {
    const a = seen.get(f.name);
    return !!a && a.releaseSha === f.releaseSha;
  });
}

export interface GuidanceContext {
  migrationsRan: boolean;
  backupJobId?: string;
  planId?: string;
  clusterName?: string;
}

const RESTORE = (ctx: GuidanceContext): string => {
  if (!ctx.migrationsRan) return '';
  if (ctx.backupJobId) {
    return ` The new API already applied its database migrations; to undo them, restore the platform backup ${ctx.backupJobId}.`;
  }
  return ' The new API already applied its database migrations, and this update ran without a backup: they cannot be undone.';
};

const backupCopyNote = (ctx: GuidanceContext): string => {
  if (!ctx.planId) return '';
  const where = ctx.clusterName ? ` on ${ctx.clusterName}` : '';
  return ` A copy of every file replaced${where} is on its master in flui-refresh-backup/${ctx.planId}.`;
};

/** Fixed text saying what a person can do after a failed phase. */
export function failureGuidance(
  phase: UpgradePhaseKey,
  ctx: GuidanceContext,
): string {
  switch (phase) {
    case 'backup':
      return 'Nothing was changed. Fix the platform backup in Backups and resume, or start the update again and acknowledge going without one.';
    case 'manifests': {
      const where = backupCopyNote(ctx);
      return `The platform components were not touched.${where} Fix what the error names and resume.`;
    }
    case 'images':
      return `Roll the components back from Updates, or bring the declared images in line with \`flui env reconcile-images\`, then resume.${RESTORE(ctx)}`;
    case 'k3s':
      return `K3s is never downgraded. Fix the node named above so it is Ready again, then resume the update.${RESTORE(ctx)}`;
    case 'verify':
      return `Everything was applied, but a check did not pass. Look at what failed and resume to check again.${RESTORE(ctx)}`;
  }
}

export interface BudgetContext {
  clusters?: number;
  components?: number;
  steps?: number;
  nodes?: number;
  /** K3s: minor steps and node count of every cluster the phase moves. */
  k3sClusters?: Array<{ steps: number; nodes: number }>;
}

/** How long a phase may run before the watchdog calls it stalled. */
export function phaseBudgetMs(
  phase: UpgradePhaseKey,
  ctx: BudgetContext,
): number {
  switch (phase) {
    case 'backup':
      return 60 * MINUTE;
    case 'manifests':
      return 10 * MINUTE * Math.max(1, ctx.clusters ?? 1);
    case 'images':
      return 15 * MINUTE * Math.max(1, ctx.components ?? 1) + 15 * MINUTE;
    case 'k3s': {
      const clusters = ctx.k3sClusters?.length
        ? ctx.k3sClusters
        : [{ steps: ctx.steps ?? 1, nodes: ctx.nodes ?? 1 }];
      return clusters.reduce(
        (total, c) =>
          total +
          K3S_CONTROLLER_WAIT_MS +
          Math.max(1, c.steps) *
            (K3S_STEP_BASE_MS + K3S_STEP_PER_NODE_MS * Math.max(1, c.nodes)),
        0,
      );
    }
    case 'verify':
      return 10 * MINUTE;
  }
}

export function isAcknowledged(text: string | undefined | null): boolean {
  return (
    typeof text === 'string' &&
    text.trim().toLowerCase() === WITHOUT_BACKUP_ACKNOWLEDGEMENT.toLowerCase()
  );
}
