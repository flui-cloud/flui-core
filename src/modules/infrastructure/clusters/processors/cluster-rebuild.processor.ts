import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bull';
import { Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStatus,
} from '../../servers/entities/infrastructure-operations.entity';
import {
  ClusterRebuildService,
  RebuildResultApp,
} from '../services/cluster-rebuild.service';

export interface RebuildClusterJobData {
  operationId: string;
  userId: string;
  fromId: string;
  toId: string;
  includeStopped: boolean;
}

/**
 * A rebuild is minutes of work per application — a restore, a deploy and a
 * rollout — so it runs as an operation and reports each application as it
 * lands, rather than as one HTTP call nobody can watch or survive.
 *
 * Its own class rather than another branch of ClusterQueueProcessor: that one
 * carries twenty dependencies for the provider side of a cluster's life, and
 * this needs none of them.
 */
@Processor('infrastructure')
export class ClusterRebuildProcessor {
  private readonly logger = new Logger(ClusterRebuildProcessor.name);

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepo: Repository<InfrastructureOperationEntity>,
    private readonly rebuild: ClusterRebuildService,
  ) {}

  @Process('rebuild-cluster')
  async handle(job: Job<RebuildClusterJobData>): Promise<void> {
    const { operationId, userId, fromId, toId, includeStopped } = job.data;
    await this.operationRepo.update(
      { id: operationId },
      { status: OperationStatus.IN_PROGRESS, startedAt: new Date() },
    );

    try {
      const result = await this.rebuild.execute(userId, fromId, toId, {
        includeStopped,
        onProgress: (done) => this.report(operationId, done),
      });

      // Partly complete is not failed. Applications that came back are running
      // on recovered data whatever happened to the rest, and a re-run continues
      // from where each one stopped — so the operation records what is true and
      // leaves the decision to a person.
      await this.operationRepo.update(
        { id: operationId },
        {
          status: OperationStatus.COMPLETED,
          completedAt: new Date(),
          progress: 100,
          errorMessage: result.complete
            ? undefined
            : this.summarise(result.apps),
        },
      );
      await this.merge(operationId, { apps: result.apps, ...result });
      this.logger.log(
        `Rebuild ${result.from} → ${result.to}: ${result.apps.filter((a) => a.phase === 'reconciled').length}/${result.apps.length} reconciled`,
      );
    } catch (err: any) {
      const message = err?.message ?? String(err);
      await this.operationRepo.update(
        { id: operationId },
        {
          status: OperationStatus.FAILED,
          completedAt: new Date(),
          errorMessage: message.slice(0, 500),
        },
      );
      this.logger.error(`Rebuild failed: ${message}`);
      throw err;
    }
  }

  private async report(
    operationId: string,
    done: RebuildResultApp[],
  ): Promise<void> {
    const attempted = done.filter((a) => a.phase !== 'skipped').length;
    await this.operationRepo.update(
      { id: operationId },
      { currentStepIndex: attempted, currentStepProgress: 0 },
    );
    await this.merge(operationId, { apps: done });
  }

  /** Metadata is a whole column, so a partial write would drop the plan. */
  private async merge(
    operationId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const operation = await this.operationRepo.findOne({
      where: { id: operationId },
    });
    if (!operation) return;
    operation.metadata = { ...(operation.metadata ?? {}), ...patch } as never;
    await this.operationRepo.save(operation);
  }

  private summarise(apps: RebuildResultApp[]): string {
    return apps
      .filter((a) => a.phase !== 'reconciled')
      .map((a) => `${a.name}: ${a.phase}${a.error ? ` — ${a.error}` : ''}`)
      .join('; ')
      .slice(0, 500);
  }
}
