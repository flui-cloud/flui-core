import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
} from '../../clusters/entities/cluster.entity';
import { managementNetworkOn } from '../management-network.state';
import { WireGuardHubService } from './wireguard-hub.service';
import { WireGuardReconciler } from './wireguard-reconciler.service';

/**
 * How long an operation waits for the members to take a control change. Past
 * it the operation moves on with a warning and the rewrite carries on behind
 * it: every sweep renders each member's config from the table again, so a
 * member still unreachable then converges there, and one dead member host
 * cannot hold a worker's add or removal for its SSH timeouts.
 */
export const MEMBER_REWRITE_BUDGET_MS = 120_000;

/**
 * A control node joining or leaving, carried to every member in the same
 * operation rather than at the next sweep: until a member's config names a new
 * control node, a copy of the API scheduled there cannot reach that member.
 */
@Injectable()
export class ControlMembershipService {
  private readonly logger = new Logger(ControlMembershipService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly hub: WireGuardHubService,
    private readonly reconciler: WireGuardReconciler,
  ) {}

  /** After a control node joined. Returns what did not converge, in words. */
  async afterControlNodesJoined(): Promise<string[]> {
    if (!managementNetworkOn()) return [];
    const end = await this.hub.ensureControlEnd();
    if (!end) {
      return ['the control cluster has no end of the Flui network yet'];
    }
    const problems = end.nodes
      .filter((n) => !n.applied)
      .map((n) => `control node ${n.host}: ${n.error ?? 'not applied'}`);
    return [...problems, ...(await this.reapplyMembersWithin())];
  }

  /** Before a control node is deleted, so no member keeps dialling it. */
  async beforeControlNodeRemoved(nodeId: string): Promise<string[]> {
    if (!managementNetworkOn()) return [];
    if (!(await this.hub.withdrawControlNode(nodeId))) return [];
    return this.reapplyMembersWithin();
  }

  private async reapplyMembersWithin(): Promise<string[]> {
    const work = this.reapplyMembers().catch((error: Error) => [
      `members: ${error.message}`,
    ]);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<string[]>((resolve) => {
      timer = setTimeout(
        () =>
          resolve([
            `members still being rewritten after ${MEMBER_REWRITE_BUDGET_MS / 1000}s; the next sweep finishes it`,
          ]),
        MEMBER_REWRITE_BUDGET_MS,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([work, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async reapplyMembers(): Promise<string[]> {
    const workloads = await this.clusters.find({
      where: { clusterType: ClusterType.WORKLOAD, status: ClusterStatus.READY },
    });
    const problems: string[] = [];
    for (const cluster of workloads) {
      try {
        for (const outcome of await this.reconciler.applyCluster(cluster.id, {
          enrolledOnly: true,
        })) {
          if (outcome.error) {
            problems.push(`${cluster.name}/${outcome.host}: ${outcome.error}`);
          }
        }
      } catch (error) {
        problems.push(`${cluster.name}: ${(error as Error).message}`);
      }
    }
    if (problems.length) {
      this.logger.warn(
        `[wg] members not yet converged on the control change: ${problems.join('; ')}`,
      );
    }
    return problems;
  }
}
