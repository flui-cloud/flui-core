import { NodeEvent } from '../scaling.core';

export interface NodeEventFacts {
  event: NodeEvent;
  node?: string | null;
  shape?: string | null;
  region?: string | null;
  /** Who asked for it, when a person did; null when the group did. */
  by?: string | null;
  minutes?: number | null;
  error?: string | null;
  warning?: string | null;
}

export interface NodeEventText {
  saw: string;
  did: string;
  why: string;
}

export function nodeEventText(f: NodeEventFacts): NodeEventText {
  const machine = [f.shape, f.region].filter(Boolean).join(' in ') || 'machine';
  const named = f.node ? `${f.node} (${machine})` : `The ${machine}`;
  const asker = f.by ? `${f.by} asked for it` : 'The group asked for it';
  switch (f.event) {
    case 'node-ordered':
      return {
        saw: `${f.by ?? 'A person'} asked for a machine.`,
        did: `Ordered a ${machine}.`,
        why: "Ordered by hand, outside the group's own decisions.",
      };
    case 'node-joined':
      return {
        saw: `${named} is ready.`,
        did: `${named} joined the cluster${f.minutes != null ? ' after ' + f.minutes + ' min' : ''}.`,
        why: `${asker}; the order completed.`,
      };
    case 'purchase-failed':
      return {
        saw: `The order for a ${machine} did not complete.`,
        did: `No ${machine} was added.`,
        why: f.error ?? 'The provider refused it.',
      };
    case 'node-drained':
      return {
        saw: `${named} is leaving.`,
        did: `${named} was emptied; its apps moved to the other nodes.`,
        why: f.warning ?? `${asker}.`,
      };
    case 'node-removed':
      return {
        saw: `${named} was emptied.`,
        did: `${named} was deleted at the provider.`,
        why: `${asker}; it is no longer billed.`,
      };
  }
}
