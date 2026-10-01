import { ClusterEntity } from '../entities/cluster.entity';
import {
  ControlPair,
  ControlRestorePlan,
  PreviousControl,
  RebuildMode,
} from '../interfaces/cluster-rebuild.interface';
import { isControl, isRetired } from './rebuild-scope.util';

export const NO_LIVE_CONTROL_REFUSAL =
  'This installation has no control cluster of its own on record, so ' +
  'there is nowhere to restore onto.';

/**
 * The live control is the newest control row nobody retired — the same
 * rule the platform uses to find itself after a restore, when the dump has
 * brought the old installation's row back beside the one this install
 * seeded. `controls` comes newest first.
 */
export function liveControl(
  controls: ClusterEntity[],
): ClusterEntity | undefined {
  return controls.find((c) => !isRetired(c));
}

export function toCandidate(
  cluster: ClusterEntity,
  applications: number,
): PreviousControl {
  return {
    id: cluster.id,
    name: cluster.name,
    status: cluster.status,
    retired: isRetired(cluster),
    applications,
  };
}

function describeCandidate(candidate: PreviousControl): string {
  return candidate.name + ' ' + candidate.id;
}

/**
 * `fromId` may be omitted when exactly one earlier control cluster still has
 * applications recorded on it.
 */
export function chooseControlSource(
  to: ClusterEntity,
  earlier: ClusterEntity[],
  candidates: PreviousControl[],
  fromId?: string,
): ControlPair {
  if (fromId) {
    const from = earlier.find((c) => c.id === fromId);
    if (!from) {
      return {
        refusal:
          fromId === to.id
            ? `${to.name} is this installation's own control cluster, not one it was restored from.`
            : `${fromId} is not a control cluster this installation knows of.`,
        to,
        candidates,
      };
    }
    return { from, to, candidates };
  }

  if (candidates.length === 0) {
    return {
      refusal:
        'No earlier control cluster has applications recorded on it: there ' +
        'is nothing to restore onto this one.',
      to,
      candidates,
    };
  }
  if (candidates.length > 1) {
    return {
      refusal:
        `${candidates.length} earlier control clusters have applications ` +
        `recorded on them (${candidates.map(describeCandidate).join(', ')}). ` +
        'Name the one to restore from.',
      to,
      candidates,
    };
  }
  const from = earlier.find((c) => c.id === candidates[0].id)!;
  return { from, to, candidates };
}

function summary(cluster?: ClusterEntity): ControlRestorePlan['from'] {
  return cluster
    ? { id: cluster.id, name: cluster.name, status: cluster.status }
    : { id: '', name: '—', status: '' };
}

export function refusedControlPlan(
  resolved: Extract<ControlPair, { refusal: string }>,
): ControlRestorePlan {
  return {
    mode: 'control',
    from: summary(resolved.from),
    to: summary(resolved.to),
    apps: [],
    refusals: [resolved.refusal],
    warnings: [],
    candidates: resolved.candidates,
  };
}

/** Why this pair of clusters cannot be rebuilt in this mode, if it cannot. */
export function modeRefusals(
  mode: RebuildMode,
  from: ClusterEntity,
  to: ClusterEntity,
): string[] {
  const refusals: string[] = [];
  if (mode === 'workload' && isControl(to)) {
    refusals.push(
      'The control cluster runs the plane doing the rebuilding, and is not a ' +
        'destination for workloads. To bring back the applications of a ' +
        'control cluster this installation was restored from, restore them ' +
        'onto this control cluster instead.',
    );
  }
  if (mode === 'workload' && isControl(from)) {
    refusals.push(
      `${from.name} is a control cluster. Its applications come back onto ` +
        "this installation's own control cluster, by restoring them there.",
    );
  }
  if (mode === 'control' && (!isControl(from) || !isControl(to))) {
    refusals.push(
      'Restoring onto the control cluster takes a previous control cluster ' +
        'as the source and this installation’s control cluster as the destination.',
    );
  }
  return refusals;
}

/**
 * A name keeps its zone only where the destination serves that zone. A
 * restored control starts with none of the old one's zones, so without an
 * assignment the names come back unchanged and nothing re-issues their
 * certificates.
 */
export function missingZoneWarnings(
  toName: string,
  missing: string[],
): string[] {
  if (missing.length === 0) return [];
  const pronoun = missing.length === 1 ? 'it' : 'them';
  return [
    `${toName} does not serve ${missing.join(', ')} yet. Assign ${pronoun} ` +
      `with \`flui dns zone assign <zone> --cluster ${toName}\` before restoring, ` +
      'or the applications keep their names without the zone that publishes them.',
  ];
}
