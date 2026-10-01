import { OperationStep } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { PlatformUpdateStatusDto } from '../dto/platform-update.dto';
import { PLATFORM_UPDATE_COMPONENTS } from '../constants/platform-update-components';
import { K3sUpgradePlan } from '../interfaces/k3s-upgrade.interface';
import {
  PlatformUpgradeMetadata,
  PlatformUpgradePlan,
  UpgradePhaseState,
  UpgradePlanAdvisory,
  UpgradePlanBlocker,
  UpgradePlanCluster,
  UpgradePlanComponent,
  UpgradePlanPhase,
  WITHOUT_BACKUP_ACKNOWLEDGEMENT,
} from '../interfaces/platform-upgrade.interface';
import { Judgement } from './manifest-eligibility.util';
import {
  PHASE_ORDER,
  PHASE_TITLE,
  k3sOrder,
  writableFiles,
} from './platform-upgrade.util';

const SUC = 'system-upgrade-controller';

export const UPGRADE_STEPS = [
  {
    step: OperationStep.PLATFORM_UPDATE_BACKUP,
    description: PHASE_TITLE.backup,
    weight: 10,
  },
  {
    step: OperationStep.PLATFORM_UPDATE_MANIFESTS,
    description: PHASE_TITLE.manifests,
    weight: 15,
  },
  {
    step: OperationStep.PLATFORM_UPDATE_COMPONENTS,
    description: PHASE_TITLE.images,
    weight: 30,
  },
  {
    step: OperationStep.PLATFORM_UPDATE_K3S,
    description: PHASE_TITLE.k3s,
    weight: 35,
  },
  {
    step: OperationStep.PLATFORM_UPDATE_VERIFY,
    description: PHASE_TITLE.verify,
    weight: 10,
  },
];

export interface ClusterRef {
  id: string;
  name: string;
  clusterType: 'control' | 'workload';
}

export type PlannedEntry = Judgement & { releaseSha?: string };

export const VERIFY_PHASE: UpgradePlanPhase = {
  key: 'verify',
  title: PHASE_TITLE.verify,
  willRun: true,
  summary:
    'Checks every node runs the target K3s, the system components are available, the API answers on the new version and the ingress is ready.',
  blockers: [],
};

/** What stops the release as a whole, and the advisories that carry over. */
export function releaseAssessment(
  status: Pick<
    PlatformUpdateStatusDto,
    'updateAvailable' | 'availableVersion' | 'advisories'
  >,
  target: string,
): { blockers: UpgradePlanBlocker[]; advisories: UpgradePlanAdvisory[] } {
  const blockers: UpgradePlanBlocker[] = [];
  const advisories: UpgradePlanAdvisory[] = [];
  if (!status.updateAvailable || !target) {
    blockers.push({
      phase: 'release',
      message: 'This installation is already up to date.',
    });
  } else if (status.availableVersion !== target) {
    blockers.push({
      phase: 'release',
      message: `Release ${target} is not the one on offer; ${status.availableVersion} is.`,
    });
  }
  for (const a of status.advisories) {
    if (a.level === 'blocker') {
      blockers.push({ phase: 'release', message: `${a.title}. ${a.detail}` });
    } else if (!a.title.startsWith('This release changes the bootstrap')) {
      advisories.push(a);
    }
  }
  return { blockers, advisories };
}

/** What the whole update will do to the installation while it runs. */
export function updateAdvisories(
  migrations: number,
  k3s: UpgradePlanPhase,
): UpgradePlanAdvisory[] {
  const out: UpgradePlanAdvisory[] = [];
  if (migrations > 0) {
    out.push({
      level: 'warning',
      title: `${migrations} database migration(s) will run`,
      detail:
        'The new API applies them when it starts. Restoring the backup taken first is the only way back.',
    });
  }
  if (k3s.clusters?.some((c) => c.clusterType === 'control' && !c.upToDate)) {
    out.push({
      level: 'warning',
      title: 'The control cluster is unreachable for a minute or two',
      detail:
        'While K3s restarts on the control, the dashboard, the CLI and the API stop answering. Running applications keep serving traffic.',
    });
  }
  return out;
}

export function backupPhaseFor(
  policy: { id: string; name: string; userId?: string | null } | null,
): UpgradePlanPhase {
  const blockers: UpgradePlanBlocker[] = [];
  if (!policy) {
    blockers.push({
      phase: 'backup',
      message:
        'No platform backup is set up, so nothing can be backed up first.',
      overridable: true,
    });
  } else if (!policy.userId) {
    blockers.push({
      phase: 'backup',
      message: `The platform backup "${policy.name}" has no owner to run it as. Recreate it from Backups.`,
      overridable: true,
    });
  }
  return {
    key: 'backup',
    title: PHASE_TITLE.backup,
    willRun: !!policy,
    summary: policy
      ? `Runs the platform backup "${policy.name}" and waits for it to finish.`
      : 'No platform backup is set up.',
    blockers,
    backup: {
      policyId: policy?.id ?? null,
      policyName: policy?.name ?? null,
    },
  };
}

/** Stateful image changes a refresh leaves alone, as advisories. */
export function leftAloneAdvisories(
  cluster: ClusterRef,
  entries: PlannedEntry[],
): UpgradePlanAdvisory[] {
  return entries
    .filter((e) => e.action === 'skip' && e.statefulImageChanges?.length)
    .map((e) => ({
      level: 'warning' as const,
      title: `${e.name} on ${cluster.name} is left alone`,
      detail: `It would change the image of a component that keeps data (${(e.statefulImageChanges ?? []).map((c) => c.workload).join(', ')}). Read the release notes and refresh it on its own.`,
    }));
}

/**
 * Templated files a refresh cannot render because the installation keeps no
 * proven record of the values it was built with. Without saying so the plan
 * reads as if they were merely unchanged.
 */
export function missingValuesAdvisory(
  cluster: ClusterRef,
  plan: { entries: PlannedEntry[]; valuesUnavailable?: string },
): UpgradePlanAdvisory | undefined {
  if (!plan.valuesUnavailable) return undefined;
  const waiting = plan.entries.filter(
    (e) => e.action === 'skip' && e.placeholders?.length,
  );
  if (waiting.length === 0) return undefined;
  const target =
    cluster.clusterType === 'control' ? '' : ` --cluster ${cluster.name}`;
  return {
    level: 'warning',
    title: `${waiting.length} file(s) on ${cluster.name} wait for the record of the values it was built with`,
    detail: `${waiting.map((e) => e.name).join(', ')} are not brought forward: ${plan.valuesUnavailable} Rebuild the record with \`flui env install-values${target}\`, then plan again.`,
  };
}

export function manifestClusterFor(
  cluster: ClusterRef,
  plan: { planId: string; ref: string; entries: PlannedEntry[] },
): UpgradePlanCluster {
  const files = writableFiles(plan.entries);
  return {
    clusterId: cluster.id,
    clusterName: cluster.name,
    clusterType: cluster.clusterType,
    planId: plan.planId,
    ref: plan.ref,
    files,
    leftAlone: plan.entries.filter((e) => e.action === 'skip').length,
    upToDate: files.length === 0,
    blockers: plan.entries
      .filter((e) => e.missingSecretKeys?.length)
      .map(
        (e) =>
          `${e.name} on ${cluster.name} needs a Secret copied from ${e.missingSecretKeys?.join(', ')}, and that key is not there. Add it, then plan again.`,
      ),
  };
}

export function unreadableManifestCluster(
  cluster: ClusterRef,
  message: string,
): UpgradePlanCluster {
  return {
    clusterId: cluster.id,
    clusterName: cluster.name,
    clusterType: cluster.clusterType,
    upToDate: false,
    blockers: [
      `The manifests on ${cluster.name} could not be read: ${message}`,
    ],
  };
}

export function manifestPhaseFor(
  clusters: UpgradePlanCluster[],
): UpgradePlanPhase {
  const changing = clusters.filter((c) => !c.upToDate);
  return {
    key: 'manifests',
    title: PHASE_TITLE.manifests,
    willRun: changing.length > 0,
    summary:
      changing.length === 0
        ? 'Every cluster already has the manifests of this release.'
        : `${changing.map((c) => c.clusterName).join(', ')}: ${changing.reduce((n, c) => n + (c.files?.length ?? 0), 0)} file(s), the control first.`,
    blockers: clusters.flatMap((c) =>
      c.blockers.map((message) => ({ phase: 'manifests' as const, message })),
    ),
    clusters,
  };
}

function componentMove(c: UpgradePlanComponent): string {
  return `${c.name} ${c.fromVersion ?? '—'} → ${c.targetVersion}`;
}

export function imagePhaseFor(
  status: Pick<PlatformUpdateStatusDto, 'components'>,
  refs: Record<string, string>,
): UpgradePlanPhase {
  const components: UpgradePlanComponent[] = PLATFORM_UPDATE_COMPONENTS.map(
    (def) => {
      const view = status.components.find((c) => c.key === def.key);
      return {
        key: def.key,
        name: def.name,
        fromVersion: view?.installedVersion ?? null,
        targetVersion: view?.targetVersion ?? null,
        imageRef: refs[def.key] ?? '',
        changed: view?.changed ?? false,
      };
    },
  );
  const moving = components.filter((c) => c.changed);
  const unresolved = moving.filter((c) => !c.imageRef);
  return {
    key: 'images',
    title: PHASE_TITLE.images,
    willRun: moving.length > 0,
    summary:
      moving.length === 0
        ? 'No platform component changes.'
        : `${moving.map(componentMove).join(', ')}; the API last.`,
    blockers: unresolved.length
      ? [
          {
            phase: 'images',
            message: `No image could be resolved for: ${unresolved.map((c) => c.name).join(', ')}.`,
          },
        ]
      : [],
    components,
  };
}

function clusterMove(c: {
  clusterName: string;
  fromVersion?: string | null;
  steps?: string[];
}): string {
  return `${c.clusterName} ${c.fromVersion ?? '?'} → ${(c.steps ?? []).join(' → ')}`;
}

export const NO_K3S_PHASE: UpgradePlanPhase = {
  key: 'k3s',
  title: PHASE_TITLE.k3s,
  willRun: false,
  summary: 'This release does not name a K3s version.',
  blockers: [],
  clusters: [],
};

export function k3sPhaseFor(
  target: string,
  plans: K3sUpgradePlan[],
  manifests: UpgradePlanPhase,
): UpgradePlanPhase {
  const clusters = k3sOrder(plans.map((p) => k3sClusterFor(p, manifests)));
  const moving = clusters.filter((c) => !c.upToDate);
  return {
    key: 'k3s',
    title: PHASE_TITLE.k3s,
    willRun: moving.length > 0,
    summary:
      moving.length === 0
        ? `Every cluster already runs K3s ${target}.`
        : `${moving.map(clusterMove).join('; ')}. Workload clusters first, the control last.`,
    blockers: clusters.flatMap((c) =>
      c.blockers.map((message) => ({
        phase: 'k3s' as const,
        message: `${c.clusterName}: ${message}`,
      })),
    ),
    clusters,
  };
}

/** A missing upgrade controller is not a blocker when the manifests phase installs it. */
export function k3sClusterFor(
  plan: K3sUpgradePlan,
  manifests: UpgradePlanPhase,
): UpgradePlanCluster {
  const installsController = (manifests.clusters ?? [])
    .find((c) => c.clusterId === plan.clusterId)
    ?.files?.some((f) => f.name.includes(SUC));
  const blockers = installsController
    ? plan.blockers.filter((b) => !b.includes(SUC))
    : plan.blockers;
  return {
    clusterId: plan.clusterId,
    clusterName: plan.clusterName,
    clusterType: plan.clusterType,
    fromVersion: plan.observedVersion,
    steps: plan.steps,
    nodes: plan.nodes,
    upToDate: plan.upToDate,
    blockers,
  };
}

/** The operation's record of a plan, every phase pending unless the plan skips it. */
export function metadataFor(
  plan: PlatformUpgradePlan,
  withoutBackup: boolean,
): PlatformUpgradeMetadata {
  const phase = (key: string) =>
    plan.phases.find((p) => p.key === key) as UpgradePlanPhase;
  const backup = phase('backup');
  const manifests = phase('manifests');
  const images = phase('images');
  const k3s = phase('k3s');

  const states: UpgradePhaseState[] = PHASE_ORDER.map((key) => ({
    key,
    title: PHASE_TITLE[key],
    status: 'pending',
  }));
  const state = (key: string) =>
    states.find((s) => s.key === key) as UpgradePhaseState;

  state('backup').policyId = backup.backup?.policyId ?? null;
  if (withoutBackup) {
    state('backup').status = 'skipped';
    state('backup').message = WITHOUT_BACKUP_ACKNOWLEDGEMENT;
  }
  state('manifests').clusters = (manifests.clusters ?? []).map((c) => ({
    clusterId: c.clusterId,
    clusterName: c.clusterName,
    clusterType: c.clusterType,
    planId: c.planId,
    approved: c.files ?? [],
    status: c.upToDate ? 'done' : 'pending',
  }));
  if (!manifests.willRun) state('manifests').status = 'skipped';
  if (!images.willRun) state('images').status = 'skipped';
  state('k3s').clusters = (k3s.clusters ?? []).map((c) => ({
    clusterId: c.clusterId,
    clusterName: c.clusterName,
    clusterType: c.clusterType,
    stepCount: c.steps?.length ?? 0,
    nodeCount: c.nodes?.length ?? 0,
    status: c.upToDate ? 'done' : 'pending',
  }));
  if (!k3s.willRun) state('k3s').status = 'skipped';

  return {
    schema: 2,
    planId: plan.planId,
    fromVersion: plan.fromVersion,
    targetVersion: plan.targetVersion,
    bootstrapRef: plan.bootstrapRef,
    k3sVersion: plan.k3sVersion,
    migrations: plan.migrations,
    withoutBackup,
    ...(withoutBackup
      ? { acknowledgement: WITHOUT_BACKUP_ACKNOWLEDGEMENT }
      : {}),
    components: (images.components ?? []).map((c) => ({
      key: c.key,
      name: c.name,
      fromVersion: c.fromVersion,
      targetVersion: c.targetVersion ?? '',
      imageRef: c.imageRef,
      status: c.changed ? 'pending' : 'skipped',
    })),
    operationSteps: UPGRADE_STEPS,
    phases: states,
  };
}
