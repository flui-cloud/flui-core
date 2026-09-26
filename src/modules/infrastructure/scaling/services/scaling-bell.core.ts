/**
 * Which rows of the scaling log reach a person's bell, and how they read
 * there. A person who is not looking at the Scaling page should still learn
 * that an app is waiting for room, that money was spent, that a machine came
 * or went, and that an alarm opened or closed — and nothing else: a standing
 * "nothing to do" is not news.
 */

export interface BellRow {
  id: string;
  groupId: string;
  clusterId: string;
  force: string;
  outcome: string;
  did: string;
  why: string;
  asks?: string | null;
  pendingPods?: number | null;
}

export interface ScalingBell {
  id: string;
  clusterId: string;
  groupId: string;
  outcome: string;
  tone: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string;
  /** Which tab of the group the link opens. */
  tab: 'now' | 'history';
  /** Offer "Try again" beside it. */
  retry: boolean;
}

export function scalingBellOf(
  row: BellRow,
  previous: Pick<BellRow, 'outcome' | 'pendingPods'> | null,
  clusterName: string,
): ScalingBell | null {
  const base = {
    id: row.id,
    clusterId: row.clusterId,
    groupId: row.groupId,
    outcome: row.outcome,
    retry: false,
  };
  const on = (title: string) => `${clusterName}: ${title}`;
  switch (row.outcome) {
    case 'added':
      return {
        ...base,
        tone: 'info',
        tab: 'now',
        title: on('a machine was ordered'),
        body: row.did,
      };
    case 'node-ordered':
      return {
        ...base,
        tone: 'info',
        tab: 'now',
        title: on('a machine was ordered by hand'),
        body: row.did,
      };
    case 'node-joined':
      return {
        ...base,
        tone: 'success',
        tab: 'now',
        title: on('a machine joined'),
        body: row.did,
      };
    case 'purchase-failed':
      return {
        ...base,
        tone: 'error',
        tab: 'now',
        title: on('a purchase failed'),
        body: row.why,
        retry: true,
      };
    case 'node-removed':
      return {
        ...base,
        tone: 'info',
        tab: 'history',
        title: on('a machine was given back'),
        body: row.did,
      };
    case 'alerted':
      return previous?.outcome === 'alerted'
        ? null
        : {
            ...base,
            tone: 'warning',
            tab: 'now',
            title: on('scaling needs a person'),
            body: row.asks ?? row.did,
          };
  }
  if (row.force === 'person' || row.force === 'fleet') return null;
  if (previous?.outcome === 'alerted') {
    return {
      ...base,
      tone: 'success',
      tab: 'history',
      title: on('the scaling alarm closed'),
      body: row.did,
    };
  }
  if ((row.pendingPods ?? 0) > 0 && (previous?.pendingPods ?? 0) <= 0) {
    return {
      ...base,
      tone: 'warning',
      tab: 'now',
      title: on('an app is waiting for room'),
      body: row.did,
    };
  }
  return null;
}
