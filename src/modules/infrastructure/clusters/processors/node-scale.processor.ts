import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import {
  ClusterNodeScalingService,
  ScaleNodeJobData,
} from '../services/cluster-node-scaling.service';

/**
 * A resize is minutes of a node switched off, so it runs as a job: an API
 * that restarts meanwhile picks it up again instead of leaving the node
 * cordoned or off.
 */
@Processor('infrastructure')
export class NodeScaleProcessor {
  constructor(private readonly scaling: ClusterNodeScalingService) {}

  @Process('scale-node')
  async handle(job: Job<ScaleNodeJobData>): Promise<void> {
    await this.scaling.runScaleNode(job.data.operationId);
  }
}
