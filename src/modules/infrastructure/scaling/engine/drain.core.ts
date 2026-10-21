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
  | 'is-master'
  | 'runs-flui-api';

/** The application something on the node belongs to, when Flui deployed it. */
export interface DrainApplication {
  id: string;
  slug: string;
}

export interface DrainBlocker {
  kind: DrainBlockerKind;
  /** The thing itself, by the name a person would recognise. */
  what: string;
  /** What would have to change for the drain to become possible. */
  fix: string;
  /** Absent on checks recorded before blockers were tied to applications. */
  application?: DrainApplication | null;
}

export interface DrainCheck {
  ok: boolean;
  blockers: DrainBlocker[];
  /** Checks that passed, so the answer reads as an answer rather than a green light. */
  cleared: string[];
  /** The node asked about. Absent on checks recorded before it was kept. */
  node?: string;
  /** What emptying the node would start again elsewhere. Absent on older checks. */
  moves?: DrainMove[];
}

export interface DrainMove {
  /** The application's name, or the component's when Flui did not deploy it. */
  what: string;
  /** Part of the platform itself rather than something a person deployed. */
  system: boolean;
  application?: DrainApplication | null;
}

/** Where the platform's own parts run. */
export const SYSTEM_NAMESPACES = new Set([
  'flui-system',
  'flui-control',
  'kube-system',
]);

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
  application?: DrainApplication | null;
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
  dedicatedApps: DrainApplication[];
  pods: DrainPod[];
  budgets: DrainBudget[];
  /**
   * Ready copies of the Flui API on other nodes. While one runs elsewhere, the
   * copy here is just another replica to move; absent is read as none.
   */
  apiCopiesElsewhere?: number;
}

const DAEMONSET = 'DaemonSet';

export function checkDrain(subject: DrainSubject): DrainCheck {
  // Refused by name rather than deduced. It carries the control plane and the
  // storage the rest of the cluster mounts, and no count of pods says that.
  if (subject.isMaster) {
    return {
      ok: false,
      node: subject.nodeName,
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

  for (const app of subject.dedicatedApps) {
    blockers.push({
      kind: 'dedicated-app',
      what: app.slug,
      fix: `${app.slug} keeps its data on this machine. Back it up, then delete or redeploy it elsewhere.`,
      application: app,
    });
  }
  const dedicated = new Set(subject.dedicatedApps.map((app) => app.id));

  const daemons = subject.pods.filter((pod) => pod.ownerKind === DAEMONSET);
  const evictable = subject.pods.filter((pod) => pod.ownerKind !== DAEMONSET);

  for (const pod of evictable) {
    blockers.push(
      ...podBlockers(pod, dedicated, subject.budgets, {
        apiElsewhere: (subject.apiCopiesElsewhere ?? 0) > 0,
      }),
    );
  }

  if (daemons.length) {
    cleared.push(
      `${daemons.length} part(s) that run on every machine stay where they are: emptying neither moves them nor waits for them.`,
    );
  }
  if (evictable.length && !blockers.some((b) => b.kind === 'no-controller')) {
    cleared.push(
      `${evictable.length} part(s) would be started again on another machine.`,
    );
  }
  if (!evictable.some((pod) => pod.boundVolumes.length)) {
    cleared.push(
      'Nothing on this node holds a volume that cannot move with it.',
    );
  }
  if (
    subject.budgets.length &&
    !blockers.some((b) => b.kind === 'disruption-budget')
  ) {
    cleared.push(
      `${subject.budgets.length} rule(s) limit how much may stop at once here, and none of them refuses.`,
    );
  }
  if (!subject.dedicatedApps.length) {
    cleared.push('No application keeps its data on this machine.');
  }

  return {
    ok: blockers.length === 0,
    node: subject.nodeName,
    blockers,
    cleared,
    moves: movesOf(evictable),
  };
}

function podBlockers(
  pod: DrainPod,
  dedicated: Set<string>,
  budgets: DrainBudget[],
  api: { apiElsewhere: boolean },
): DrainBlocker[] {
  const where = `${pod.namespace}/${pod.name}`;
  const application = pod.application ?? null;
  const blockers: DrainBlocker[] = [];

  // The removal is carried out by the API itself: a drain that evicts its only
  // copy stops the removal halfway, with the node cordoned and the operation
  // left running for nobody to finish. With a copy elsewhere, the work is
  // handed to that one and this copy is just another replica to move.
  if (isFluiApi(pod) && !api.apiElsewhere) {
    blockers.push({
      kind: 'runs-flui-api',
      what: where,
      fix: 'The only copy of the Flui API runs on this machine and is what carries out the removal, so emptying it would stop the removal halfway. Nothing is changed: the removal waits until a copy of the Flui API runs on another machine.',
      application,
    });
  }

  if (pod.mirror) {
    blockers.push({
      kind: 'not-evictable',
      what: where,
      fix: 'This part is placed by the machine itself and cannot be moved. Remove it from the machine first.',
      application,
    });
    return blockers;
  }

  if (!pod.ownerKind) {
    blockers.push({
      kind: 'no-controller',
      what: where,
      fix: 'Nothing would start this again elsewhere. Deploy it as an app, or delete it and accept that it goes.',
      application,
    });
  }

  // A dedicated application's volume is the reason it is dedicated, and it is
  // already named once for it.
  if (
    pod.boundVolumes.length &&
    !(application && dedicated.has(application.id))
  ) {
    blockers.push({
      kind: 'bound-volume',
      what: `${where} → ${pod.boundVolumes.join(', ')}`,
      fix: 'The disk lives on this machine and does not travel. Move the data, or give the app storage that any machine can reach.',
      application,
    });
  }

  const refusing = budgetRefusing(pod, budgets);
  if (refusing) {
    blockers.push({
      kind: 'disruption-budget',
      what: `${refusing.namespace}/${refusing.name} (covers ${where})`,
      fix: 'The budget permits no further disruption. Scale the workload up, or relax the budget, before this node can be emptied.',
      application,
    });
  }
  return blockers;
}

function isFluiApi(pod: DrainPod): boolean {
  return pod.namespace === 'flui-system' && pod.labels['app'] === 'flui-api';
}

/** One entry per application or component, however many replicas it runs here. */
function movesOf(pods: DrainPod[]): DrainMove[] {
  const seen = new Map<string, DrainMove>();
  for (const pod of pods) {
    const what =
      pod.application?.slug ??
      pod.labels['app.kubernetes.io/name'] ??
      pod.labels['app'] ??
      pod.name;
    const key = `${pod.namespace}/${what}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      what,
      system: SYSTEM_NAMESPACES.has(pod.namespace),
      application: pod.application ?? null,
    });
  }
  return [...seen.values()];
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

/** What emptying a node starts again elsewhere, the platform's own parts first. */
export function movesSentence(moves: DrainMove[]): string | null {
  if (!moves.length) return null;
  const named = [...moves]
    .sort((a, b) => Number(b.system) - Number(a.system))
    .map((move) => (move.system ? `${move.what} (Flui)` : move.what));
  return `Started again on another machine: ${named.join(', ')}.`;
}

/** One line naming what stands in the way, for a decision that has to say it. */
export function drainSummary(check: DrainCheck): string {
  if (check.ok) return 'The node can be emptied.';
  return check.blockers
    .map((blocker) => `${blocker.what}: ${blocker.fix}`)
    .join(' ');
}
