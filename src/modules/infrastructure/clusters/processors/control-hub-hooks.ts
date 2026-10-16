import { Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  ClusterEntity,
  isControlClusterType,
} from '../entities/cluster.entity';
import { ControlMembershipService } from '../../networking/services/control-membership.service';

export interface HubWarning {
  code: string;
  reason: string;
}

export interface OperationWarning {
  code: string;
  message: string;
}

/** What an add-worker operation completes with: admission first, then the hub. */
export function operationWarnings(
  admission: OperationWarning | null,
  hub: HubWarning[],
): OperationWarning[] {
  return [
    ...(admission ? [admission] : []),
    ...hub.map((w) => ({ code: w.code, message: w.reason })),
  ];
}

function membership(moduleRef?: ModuleRef): ControlMembershipService | null {
  try {
    return moduleRef?.get(ControlMembershipService, { strict: false }) ?? null;
  } catch {
    return null;
  }
}

/**
 * A worker joined the control cluster: it becomes an end of the Flui network
 * and every member learns it in this operation, so a copy of the API scheduled
 * there reaches the workload clusters at once.
 */
export async function joinControlHub(
  cluster: ClusterEntity,
  moduleRef: ModuleRef | undefined,
  logger: Logger,
): Promise<HubWarning[]> {
  if (!isControlClusterType(cluster.clusterType)) return [];
  const service = membership(moduleRef);
  if (!service) return [];
  try {
    const problems = await service.afterControlNodesJoined();
    return problems.length
      ? [{ code: 'CONTROL_HUB_NOT_CONVERGED', reason: problems.join('; ') }]
      : [];
  } catch (error) {
    const reason = (error as Error).message;
    logger.warn(`[add-worker] ${cluster.id}: Flui network: ${reason}`);
    return [{ code: 'CONTROL_HUB_NOT_CONVERGED', reason }];
  }
}

/** A control worker is about to go: members stop dialling it first. */
export async function leaveControlHub(
  cluster: ClusterEntity,
  nodeId: string,
  moduleRef: ModuleRef | undefined,
  logger: Logger,
): Promise<HubWarning[]> {
  if (!isControlClusterType(cluster.clusterType)) return [];
  const service = membership(moduleRef);
  if (!service) return [];
  try {
    const problems = await service.beforeControlNodeRemoved(nodeId);
    return problems.length
      ? [{ code: 'CONTROL_HUB_NOT_CONVERGED', reason: problems.join('; ') }]
      : [];
  } catch (error) {
    const reason = (error as Error).message;
    logger.warn(`[remove-worker] ${cluster.id}: Flui network: ${reason}`);
    return [{ code: 'CONTROL_HUB_NOT_CONVERGED', reason }];
  }
}
