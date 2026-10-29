import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ClusterHaService } from '../../../cluster-ha/services/cluster-ha.service';
import { ClusterScalingService } from './cluster-scaling.service';
import { AddHaNodeDto } from '../dto/add-ha-node.dto';
import { haNodeRefusal } from '../utils/ha-node-request.core';

/**
 * An operator adds the node a cluster across three locations still lacks,
 * with its role and its location. Nothing adds one on its own: a server
 * changes the votes the control plane counts, and the person who pays for
 * it decides when.
 */
@Injectable()
export class HaNodesService {
  private readonly logger = new Logger(HaNodesService.name);

  constructor(
    private readonly clusterHa: ClusterHaService,
    private readonly scaling: ClusterScalingService,
  ) {}

  async add(
    clusterId: string,
    dto: AddHaNodeDto,
    by: string,
  ): Promise<{ operationId: string; role: string; zone: string }> {
    const ha = await this.clusterHa.inspect(clusterId, dto.force ?? false);
    const refusal = haNodeRefusal(
      ha.cluster.name,
      ha.state,
      dto.role,
      dto.zone,
    );
    if (refusal) throw new BadRequestException(refusal);
    const operation = await this.scaling.addWorkers(
      clusterId,
      1,
      dto.serverType ?? null,
      dto.zone,
      by,
      dto.role,
    );
    this.logger.log(
      `[ha] ${ha.cluster.name}: adding a ${dto.role} in ${dto.zone} (operation ${operation.id})`,
    );
    return { operationId: operation.id, role: dto.role, zone: dto.zone };
  }
}
