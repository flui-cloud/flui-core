import { OperationStep } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import {
  PlatformUpgradeMetadata,
  UpgradePhaseKey,
  UpgradePhaseState,
} from '../interfaces/platform-upgrade.interface';
import { BudgetContext, failureGuidance } from './platform-upgrade.util';
import { splitImageRef } from './declared-image.util';

export const PHASE_STEP: Record<
  UpgradePhaseKey,
  { step: OperationStep; index: number; progress: number }
> = {
  backup: { step: OperationStep.PLATFORM_UPDATE_BACKUP, index: 0, progress: 5 },
  manifests: {
    step: OperationStep.PLATFORM_UPDATE_MANIFESTS,
    index: 1,
    progress: 15,
  },
  images: {
    step: OperationStep.PLATFORM_UPDATE_COMPONENTS,
    index: 2,
    progress: 35,
  },
  k3s: { step: OperationStep.PLATFORM_UPDATE_K3S, index: 3, progress: 65 },
  verify: {
    step: OperationStep.PLATFORM_UPDATE_VERIFY,
    index: 4,
    progress: 90,
  },
};

export function phaseOf(
  metadata: PlatformUpgradeMetadata,
  key: UpgradePhaseKey,
): UpgradePhaseState {
  const phase = metadata.phases.find((p) => p.key === key);
  if (!phase) throw new Error(`The operation records no ${key} phase.`);
  return phase;
}

/** The new API applies its migrations at start-up: once it runs, they ran. */
export function migrationsRan(
  metadata: PlatformUpgradeMetadata,
  runningVersion: string,
): boolean {
  if (!metadata.migrations) return false;
  const api = metadata.components.find((c) => c.key === 'fluiApi');
  return (
    runningVersion === metadata.targetVersion ||
    (api?.status === 'done' && api.targetVersion === metadata.targetVersion)
  );
}

/**
 * The record of a failed phase: where it stopped, which cluster, and the fixed
 * text saying what a person can do.
 */
export function failedMetadata(
  metadata: PlatformUpgradeMetadata,
  key: UpgradePhaseKey,
  message: string,
  runningVersion: string,
  now: Date,
  clusterId?: string,
): PlatformUpgradeMetadata {
  const phase = phaseOf(metadata, key);
  const cluster = clusterId
    ? phase.clusters?.find((c) => c.clusterId === clusterId)
    : phase.clusters?.find((c) => c.status === 'running');
  const guidance = failureGuidance(key, {
    migrationsRan: migrationsRan(metadata, runningVersion),
    backupJobId: phaseOf(metadata, 'backup').backupJobId,
    planId: cluster?.planId,
    clusterName: cluster?.clusterName,
  });
  return {
    ...metadata,
    awaitingSelfRestart: false,
    failedPhase: key,
    guidance,
    error: message,
    components:
      key === 'images'
        ? metadata.components.map((c) =>
            c.status === 'running' ? { ...c, status: 'failed' as const } : c,
          )
        : metadata.components,
    phases: metadata.phases.map((p) =>
      p.key === key
        ? {
            ...p,
            status: 'failed',
            error: message,
            finishedAt: now.toISOString(),
            clusters: p.clusters?.map((c) =>
              c.clusterId === cluster?.clusterId
                ? { ...c, status: 'failed', error: message }
                : c,
            ),
          }
        : p,
    ),
  };
}

/** What the pod on the new version records before it carries on with K3s and the checks. */
export function continuedAfterRestart(
  metadata: PlatformUpgradeMetadata,
  now: Date,
): PlatformUpgradeMetadata {
  return {
    ...metadata,
    awaitingSelfRestart: false,
    components: metadata.components.map((c) =>
      c.key === 'fluiApi' && c.status === 'running'
        ? { ...c, status: 'done' as const }
        : c,
    ),
    phases: metadata.phases.map((p) =>
      p.key === 'images' && p.status === 'running'
        ? {
            ...p,
            status: 'done',
            finishedAt: now.toISOString(),
            deadlineAt: undefined,
          }
        : p,
    ),
  };
}

/** Clears a failure so a resume starts the failed phase again from its recorded state. */
export function resumedMetadata(
  metadata: PlatformUpgradeMetadata,
): PlatformUpgradeMetadata {
  return {
    ...metadata,
    failedPhase: undefined,
    guidance: undefined,
    error: undefined,
    components: metadata.components.map((c) =>
      c.status === 'failed' ? { ...c, status: 'pending' as const } : c,
    ),
    phases: metadata.phases.map((p) =>
      p.status === 'failed' || p.status === 'running'
        ? {
            ...p,
            status: 'pending',
            error: undefined,
            deadlineAt: undefined,
            clusters: p.clusters?.map((c) =>
              c.status === 'failed' || c.status === 'running'
                ? { ...c, status: 'pending', error: undefined }
                : c,
            ),
          }
        : p,
    ),
  };
}

/** The phase that is running and past its deadline, if any. */
export function overduePhase(
  metadata: PlatformUpgradeMetadata,
  now: number,
): UpgradePhaseState | undefined {
  return metadata.phases.find(
    (p) =>
      p.status === 'running' &&
      !!p.deadlineAt &&
      Date.parse(p.deadlineAt) < now,
  );
}

export function isOverdue(phase: UpgradePhaseState, now: number): boolean {
  return !!phase.deadlineAt && Date.parse(phase.deadlineAt) < now;
}

/** What a phase's deadline is sized by, from what is left of it. */
export function phaseBudgetContext(
  key: UpgradePhaseKey,
  metadata: PlatformUpgradeMetadata,
): BudgetContext {
  const phase = phaseOf(metadata, key);
  return {
    clusters: phase.clusters?.length,
    components: metadata.components.filter((c) => c.status !== 'skipped')
      .length,
    k3sClusters: (phase.clusters ?? [])
      .filter((c) => c.status !== 'done' && c.status !== 'skipped')
      .map((c) => ({
        steps: c.stepCount ?? 1,
        nodes: c.nodeCount ?? 1,
      })),
  };
}

/**
 * The images to declare on the control master before K3s restarts there, the
 * API first, and the images they replace.
 */
export function controlImagesToDeclare(metadata: PlatformUpgradeMetadata): {
  moved: PlatformUpgradeMetadata['components'];
  previous: string[];
} {
  const moved = metadata.components
    .filter((c) => c.status !== 'skipped' && c.imageRef)
    .sort((a, b) => Number(b.key === 'fluiApi') - Number(a.key === 'fluiApi'));
  const previous = metadata.components.flatMap((c) => {
    const ref = splitImageRef(c.imageRef);
    return ref && c.fromVersion ? [`${ref.repository}:${c.fromVersion}`] : [];
  });
  return { moved, previous };
}
