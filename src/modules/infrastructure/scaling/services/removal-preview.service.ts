import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import {
  ClusterEntity,
  isControlClusterType,
} from '../../clusters/entities/cluster.entity';
import {
  ClusterNodeEntity,
  NodeStatus,
} from '../../clusters/entities/cluster-node.entity';
import { ScalingGroupEntity } from '../entities/scaling-group.entity';
import { DrainFeasibilityService } from '../engine/drain-feasibility.service';
import { pickRemovable } from '../engine/removable.core';
import { RemovalPreview, previewRemoval } from '../engine/removal-preview.core';

/**
 * Answers "what happens to the machines if I save this", asking the cluster
 * the same questions the group asks before it gives a node back. Reads only.
 */
@Injectable()
export class RemovalPreviewService {
  constructor(
    @InjectRepository(ScalingGroupEntity)
    private readonly groups: Repository<ScalingGroupEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodes: Repository<ClusterNodeEntity>,
    private readonly drain: DrainFeasibilityService,
  ) {}

  async preview(
    groupId: string,
    proposed: { min?: number; desired?: number },
  ): Promise<RemovalPreview> {
    const group = await this.groups.findOne({ where: { id: groupId } });
    if (!group)
      throw new NotFoundException(`Scaling group ${groupId} not found`);
    const cluster = await this.clusters.findOne({
      where: { id: group.clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${group.clusterId} not found`);
    }
    const rows = await this.nodes.find({
      where: { clusterId: cluster.id, status: Not(NodeStatus.DELETING) },
    });

    const min = proposed.min ?? group.minNodes;
    const desired = Math.max(proposed.desired ?? group.desiredNodes, min);
    const leaving = rows.length > desired;
    const candidate = leaving ? pickRemovable(rows, null) : null;
    const node = candidate
      ? rows.find((row) => row.id === candidate.id)
      : undefined;
    const drain = node ? await this.drain.check(cluster, node) : null;
    const fit =
      node && drain?.ok ? await this.drain.roomElsewhere(cluster, node) : null;

    return previewRemoval({
      fleet: rows.length,
      min,
      desired,
      controlCluster: isControlClusterType(cluster.clusterType),
      candidate: candidate
        ? { name: candidate.name, shape: node?.serverType ?? null }
        : null,
      drain,
      fit,
    });
  }
}
