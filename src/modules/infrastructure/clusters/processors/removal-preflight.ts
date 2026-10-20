import { Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ClusterEntity } from '../entities/cluster.entity';
import { ClusterNodeEntity } from '../entities/cluster-node.entity';
import { DrainFeasibilityService } from '../../scaling/engine/drain-feasibility.service';
import {
  DrainCheck,
  DrainMove,
  drainSummary,
} from '../../scaling/engine/drain.core';
import { FitCheck, fitSummary } from '../../scaling/engine/fit.core';

export interface RemovalPreflight {
  /** Why the removal must not start. Null when it may go ahead. */
  held: string | null;
  /** What emptying the node starts again elsewhere, for the record and the person. */
  moves: DrainMove[];
}

/**
 * The last look before anything on the node is touched.
 *
 * The scaling group decides a removal on what it saw a minute earlier, and a
 * removal can sit in the queue behind other work; by the time it runs the API
 * may have landed on the node, or the room elsewhere may be gone. So the same
 * two questions are asked again here, before the cordon, because a removal
 * that stops after the cordon leaves a machine nobody can place work on.
 * Silence is never a yes.
 */
export function preflightVerdict(
  nodeName: string,
  check: DrainCheck | null,
  fit: FitCheck | null,
): RemovalPreflight {
  const moves = check?.moves ?? [];
  if (!check) {
    return {
      held: `Nothing was changed: the cluster could not be asked what runs on ${nodeName}.`,
      moves,
    };
  }
  if (!check.ok) {
    return { held: `Nothing was changed. ${drainSummary(check)}`, moves };
  }
  if (!fit) {
    return {
      held: `Nothing was changed: the cluster could not be asked whether the work on ${nodeName} fits on the machines that stay.`,
      moves,
    };
  }
  if (!fit.fits) {
    return { held: `Nothing was changed. ${fitSummary(fit)}`, moves };
  }
  return { held: null, moves };
}

export async function removalPreflight(
  cluster: ClusterEntity,
  node: ClusterNodeEntity,
  moduleRef: ModuleRef | undefined,
  logger: Logger,
): Promise<RemovalPreflight> {
  let drain: DrainFeasibilityService | undefined;
  try {
    drain = moduleRef?.get(DrainFeasibilityService, { strict: false });
  } catch {
    drain = undefined;
  }
  if (!drain) {
    logger.warn(
      `Removal preflight unavailable for ${node.serverName}: no drain feasibility service`,
    );
    return preflightVerdict(node.serverName, null, null);
  }
  const check = await drain.check(cluster, node);
  const fit = check?.ok ? await drain.roomElsewhere(cluster, node) : null;
  return preflightVerdict(node.serverName, check, fit);
}
