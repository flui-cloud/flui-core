/**
 * Can this node be emptied?
 *
 * Asked before a purchase rather than at removal, and that is the whole point
 * of the file. A replacement buys a machine and then drains the one it stands
 * in for; if the drain is only discovered to be impossible after the purchase,
 * the fleet is one node over for good and the bill says so every month while
 * nothing on any screen calls it a fault.
 *
 * The answer is legible rather than merely true: what blocks is named with the
 * thing that blocks and what would have to change, and what passed is listed
 * too, so "yes" is something a person can check rather than trust.
 */

export type DrainBlockerKind =
  | 'dedicated-app'
  | 'bound-volume'
  | 'no-controller'
  | 'disruption-budget'
  | 'not-evictable'
  | 'is-master';

export interface DrainBlocker {
  kind: DrainBlockerKind;
  /** The thing itself, by the name a person would recognise. */
  what: string;
  /** What would have to change for the drain to become possible. */
  fix: string;
}

export interface DrainCheck {
  ok: boolean;
  blockers: DrainBlocker[];
  /** Checks that passed, so the answer reads as an answer rather than a green light. */
  cleared: string[];
}

export interface DrainPod {
  name: string;
  namespace: string;
  /** What manages it. Null is a bare pod: nothing would recreate it elsewhere. */
  ownerKind: string | null;
  /** A pod the API server placed rather than the scheduler — it cannot be evicted. */
  mirror: boolean;
  /**
   * Volumes that cannot follow the pod to another node.
   *
   * On k3s this is the common case rather than the exotic one: the default
   * storage class writes to a directory on the node that happens to be running,
   * so a perfectly ordinary application pins itself to a machine without anyone
   * choosing that.
   */
  boundVolumes: string[];
  labels: Record<string, string>;
}

export interface DrainBudget {
  namespace: string;
  name: string;
  selector: Record<string, string>;
  /**
   * How many more evictions the budget permits right now. Null when the budget
   * has not been evaluated yet, which is not the same as zero and must not
   * refuse a drain on its own.
   */
  disruptionsAllowed: number | null;
}

export interface DrainSubject {
  nodeName: string;
  isMaster: boolean;
  /** Applications pinned to this machine by `persistenceScope: dedicated`. */
  dedicatedApps: string[];
  pods: DrainPod[];
  budgets: DrainBudget[];
}

const DAEMONSET = 'DaemonSet';

export function checkDrain(subject: DrainSubject): DrainCheck {
  // Refused by name rather than deduced. It carries the control plane and the
  // storage the rest of the cluster mounts, and no count of pods says that.
  if (subject.isMaster) {
    return {
      ok: false,
      blockers: [
        {
          kind: 'is-master',
          what: subject.nodeName,
          fix: 'Nothing replaces the master of a cluster in place. Rebuild the cluster if it has to change.',
        },
      ],
      cleared: [],
    };
  }

  const blockers: DrainBlocker[] = [];
  const cleared: string[] = [];

  for (const slug of subject.dedicatedApps) {
    blockers.push({
      kind: 'dedicated-app',
      what: slug,
      fix: `${slug} keeps its data on this machine. Back it up, then delete or redeploy it elsewhere.`,
    });
  }

  const daemons = subject.pods.filter((pod) => pod.ownerKind === DAEMONSET);
  const evictable = subject.pods.filter((pod) => pod.ownerKind !== DAEMONSET);

  for (const pod of evictable) {
    const where = `${pod.namespace}/${pod.name}`;

    if (pod.mirror) {
      blockers.push({
        kind: 'not-evictable',
        what: where,
        fix: 'A static pod is placed by the machine itself and cannot be evicted. Remove its manifest from the node first.',
      });
      continue;
    }

    if (!pod.ownerKind) {
      blockers.push({
        kind: 'no-controller',
        what: where,
        fix: 'Nothing would recreate this pod elsewhere. Give it a controller, or delete it and accept that it goes.',
      });
    }

    if (pod.boundVolumes.length) {
      blockers.push({
        kind: 'bound-volume',
        what: `${where} → ${pod.boundVolumes.join(', ')}`,
        fix: 'The volume lives on this machine and does not follow the pod. Move the data, or give the workload storage that any node can reach.',
      });
    }

    const refusing = budgetRefusing(pod, subject.budgets);
    if (refusing) {
      blockers.push({
        kind: 'disruption-budget',
        what: `${refusing.namespace}/${refusing.name} (covers ${where})`,
        fix: 'The budget permits no further disruption. Scale the workload up, or relax the budget, before this node can be emptied.',
      });
    }
  }

  if (daemons.length) {
    cleared.push(
      `${daemons.length} DaemonSet pod(s) stay where they are: a drain neither evicts them nor waits for them.`,
    );
  }
  if (evictable.length && !blockers.some((b) => b.kind === 'no-controller')) {
    cleared.push(
      `${evictable.length} pod(s) are managed by a controller that will place them again elsewhere.`,
    );
  }
  if (!blockers.some((b) => b.kind === 'bound-volume')) {
    cleared.push(
      'Nothing on this node holds a volume that cannot move with it.',
    );
  }
  if (
    subject.budgets.length &&
    !blockers.some((b) => b.kind === 'disruption-budget')
  ) {
    cleared.push(
      `${subject.budgets.length} disruption budget(s) cover pods here and none of them refuses an eviction.`,
    );
  }
  if (!subject.dedicatedApps.length) {
    cleared.push('No application keeps its data on this machine.');
  }

  return { ok: blockers.length === 0, blockers, cleared };
}

function budgetRefusing(
  pod: DrainPod,
  budgets: DrainBudget[],
): DrainBudget | null {
  return (
    budgets.find(
      (budget) =>
        budget.namespace === pod.namespace &&
        budget.disruptionsAllowed === 0 &&
        covers(budget.selector, pod.labels),
    ) ?? null
  );
}

/**
 * An empty selector in a budget matches every pod in its namespace, which is
 * the opposite of matching nothing — reading it the other way would let a
 * cluster-wide freeze pass unnoticed.
 */
function covers(
  selector: Record<string, string>,
  labels: Record<string, string>,
): boolean {
  return Object.entries(selector).every(
    ([key, value]) => labels[key] === value,
  );
}

/** One line naming what stands in the way, for a decision that has to say it. */
export function drainSummary(check: DrainCheck): string {
  if (check.ok) return 'The node can be emptied.';
  return check.blockers
    .map((blocker) => `${blocker.what}: ${blocker.fix}`)
    .join(' ');
}
