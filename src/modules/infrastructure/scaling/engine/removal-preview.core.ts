import { DrainCheck, DrainMove, movesSentence } from './drain.core';
import { FitCheck, fitSummary } from './fit.core';
import {
  GiveBackReason,
  giveBackReasons,
  giveBackSentence,
} from './give-back.core';

/**
 * What saving new node limits would do to the machines, said before anything
 * is saved.
 *
 * Lowering a target reads like editing a setting, and a minute later a server
 * is emptied and deleted. The person who saves has to know which machine goes,
 * what runs on it and where it will run next, and, when it cannot go yet, that
 * the removal waits rather than breaks.
 */

export interface RemovalPreviewInput {
  fleet: number;
  min: number;
  desired: number;
  /** A control cluster's master takes apps again once its last worker leaves. */
  controlCluster: boolean;
  candidate: { name: string; shape: string | null } | null;
  drain: DrainCheck | null;
  fit: FitCheck | null;
}

export interface RemovalPreview {
  /** Whether saving makes the group give a machine back. */
  removes: boolean;
  fleet: number;
  target: number;
  /** How many machines would leave, one at a time. */
  leaving: number;
  node: string | null;
  shape: string | null;
  /** Whether the first removal could start now. */
  proceeds: boolean;
  opensMaster: boolean;
  moves: DrainMove[];
  /** Why it waits, grouped the way a person acts on it. */
  waitsFor: GiveBackReason[];
  /** The whole answer in one line, for a terminal or an agent. */
  sentence: string;
  /** The same without the list of what moves, for a screen that lists it apart. */
  headline: string;
}

export function previewRemoval(input: RemovalPreviewInput): RemovalPreview {
  const preview = previewOf(input);
  return { ...preview, headline: preview.headline || preview.sentence };
}

function previewOf(input: RemovalPreviewInput): RemovalPreview {
  const target = Math.max(input.desired, input.min);
  const leaving = Math.max(input.fleet - target, 0);
  const base: RemovalPreview = {
    removes: leaving > 0,
    fleet: input.fleet,
    target,
    leaving,
    node: input.candidate?.name ?? null,
    shape: input.candidate?.shape ?? null,
    proceeds: false,
    opensMaster: false,
    moves: input.drain?.moves ?? [],
    waitsFor: [],
    sentence: '',
    headline: '',
  };

  if (!leaving) {
    return {
      ...base,
      sentence: `Saving changes no machine: the cluster has ${input.fleet} node(s) and the target is ${target}.`,
    };
  }
  const node = input.candidate?.name;
  if (!node) {
    return {
      ...base,
      sentence:
        'The cluster is above the new target, but every node in it is the master or already leaving, so nothing would be removed.',
    };
  }
  if (!input.drain || (input.drain.ok && !input.fit)) {
    return {
      ...base,
      sentence: `Flui would remove ${node}, but the cluster could not be asked what runs on it. Nothing on ${node} is touched until it answers.`,
    };
  }
  if (!input.drain.ok) {
    const waitsFor = giveBackReasons(input.drain);
    return {
      ...base,
      waitsFor,
      sentence: `Flui would remove ${node}, but not now: ${giveBackSentence(waitsFor)}. The removal waits, and nothing on ${node} is touched.`,
    };
  }
  if (input.fit && !input.fit.fits) {
    return {
      ...base,
      sentence: `Flui would remove ${node}, but not now: ${fitSummary(input.fit)} The removal waits, and nothing on ${node} is touched.`,
    };
  }

  const opensMaster = input.controlCluster && input.fleet - 1 === 1;
  const shape = input.candidate?.shape
    ? ' (' + input.candidate.shape + ')'
    : '';
  const parts = [`Saving removes ${node}${shape}.`];
  if (opensMaster) {
    parts.push(
      'The master takes apps again first, so what runs on it has somewhere to start.',
    );
  }
  const more =
    leaving > 1
      ? [`Then ${leaving - 1} more, one at a time, each checked the same way.`]
      : [];
  const moved = movesSentence(base.moves);
  return {
    ...base,
    proceeds: true,
    opensMaster,
    sentence: [...parts, ...(moved ? [moved] : []), ...more].join(' '),
    headline: [...parts, ...more].join(' '),
  };
}
