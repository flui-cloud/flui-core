import { DrainBlocker, DrainBlockerKind, DrainCheck } from './drain.core';

/**
 * Why a node above the target cannot go back, grouped the way a person acts on
 * it: one line per cause, each naming the applications it applies to once.
 *
 * The drain check names every pod and every volume, which is what a machine
 * needs; a person deciding whether to keep paying for a node needs to know which
 * of their applications are in the way and what to do about each kind.
 */

export type GiveBackReasonKind =
  | 'data-on-node'
  | 'not-restarted'
  | 'no-interruption'
  | 'placed-by-machine'
  | 'master';

export interface GiveBackItem {
  label: string;
  applicationId: string | null;
}

export interface GiveBackReason {
  kind: GiveBackReasonKind;
  title: string;
  fix: string;
  items: GiveBackItem[];
}

const DATA_ON_NODE: GiveBackReasonKind = 'data-on-node';

const REASON_OF: Record<DrainBlockerKind, GiveBackReasonKind> = {
  'dedicated-app': DATA_ON_NODE,
  'bound-volume': DATA_ON_NODE,
  'no-controller': 'not-restarted',
  'disruption-budget': 'no-interruption',
  'not-evictable': 'placed-by-machine',
  'is-master': 'master',
};

const WORDING: Record<
  GiveBackReasonKind,
  { title: string; fix: string; sentence: (n: number) => string }
> = {
  'data-on-node': {
    title: 'Keep their data on this machine',
    fix: 'Back the data up, then redeploy the app with storage any machine can reach, or delete it.',
    sentence: (n) =>
      `${apps(n)} ${n === 1 ? 'keeps its' : 'keep their'} data on it`,
  },
  'not-restarted': {
    title: 'Would not be started again on another machine',
    fix: 'Deploy it as an app, or delete it.',
    sentence: (n) => `${things(n)} would not be started again elsewhere`,
  },
  'no-interruption': {
    title: 'Allow no interruption right now',
    fix: 'Run more copies of the app, or relax the limit on how many may stop at once.',
    sentence: (n) =>
      `${apps(n)} ${n === 1 ? 'allows' : 'allow'} no interruption right now`,
  },
  'placed-by-machine': {
    title: 'Are placed by the machine itself',
    fix: 'Remove it from the machine first.',
    sentence: (n) => `${things(n)} placed by the machine itself`,
  },
  master: {
    title: "Is the cluster's master",
    fix: 'Nothing replaces the master of a cluster in place. Rebuild the cluster if it has to change.',
    sentence: () => "it is the cluster's master",
  },
};

const ORDER: GiveBackReasonKind[] = [
  'master',
  DATA_ON_NODE,
  'no-interruption',
  'not-restarted',
  'placed-by-machine',
];

function apps(n: number): string {
  return n === 1 ? '1 application' : `${n} applications`;
}

function things(n: number): string {
  return n === 1 ? '1 workload' : `${n} workloads`;
}

/**
 * The name to show when the blocker carries no application: a check recorded
 * before blockers were tied to one, or something Flui did not deploy. The pod,
 * without its namespace or the volume it holds.
 */
function fallbackLabel(blocker: DrainBlocker): string {
  const subject = blocker.what.split(' → ')[0].split(' (covers ')[0];
  return subject.split('/').pop() ?? subject;
}

export function giveBackReasons(drain: DrainCheck): GiveBackReason[] {
  const grouped = new Map<GiveBackReasonKind, Map<string, GiveBackItem>>();
  for (const blocker of drain.blockers) {
    const kind = REASON_OF[blocker.kind];
    const items = grouped.get(kind) ?? new Map<string, GiveBackItem>();
    const app = blocker.application ?? null;
    const item: GiveBackItem = app
      ? { label: app.slug, applicationId: app.id }
      : { label: fallbackLabel(blocker), applicationId: null };
    items.set(item.applicationId ?? `name:${item.label}`, item);
    grouped.set(kind, items);
  }

  return ORDER.filter((kind) => grouped.has(kind)).map((kind) => ({
    kind,
    title: WORDING[kind].title,
    fix: WORDING[kind].fix,
    items: [...(grouped.get(kind)?.values() ?? [])],
  }));
}

/** "5 applications keep their data on it", joined across causes. */
export function giveBackSentence(reasons: GiveBackReason[]): string {
  return reasons
    .map((reason) => WORDING[reason.kind].sentence(reason.items.length))
    .join('; ');
}
