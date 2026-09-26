import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MaintenanceService } from '../../infrastructure/maintenance/maintenance.service';
import { settleDeferredProposal } from '../../infrastructure/maintenance/maintenance-window.core';
import { ResourceProposalService } from './resource-proposal.service';

/**
 * Runs the resource changes held for a maintenance window once it opens,
 * after reading the evidence again: what applied an hour ago is not applied
 * blindly now.
 */
@Injectable()
export class DeferredProposalRunnerService {
  private readonly logger = new Logger(DeferredProposalRunnerService.name);
  private running = false;

  constructor(
    private readonly maintenance: MaintenanceService,
    private readonly proposals: ResourceProposalService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runDue();
    } catch (err) {
      this.logger.error(`[deferred] pass failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async runDue(now = new Date()): Promise<number> {
    const due = await this.maintenance.due(now);
    for (const row of due) {
      if (row.kind !== 'apply-resource-proposal' || !row.applicationId)
        continue;
      try {
        const { proposal } = await this.proposals.proposalOf(row.applicationId);
        const verdict = settleDeferredProposal({
          proposal: proposal
            ? {
                problem: proposal.consequence.problem,
                verdict: proposal.consequence.placement.verdict,
                sentence: proposal.consequence.placement.sentence,
              }
            : null,
        });
        if (verdict.status === 'apply') {
          await this.proposals.apply(row.applicationId, {
            name: `${row.requestedBy} (held for the maintenance window)`,
          });
          await this.maintenance.settle(
            row,
            'applied',
            `Applied in the maintenance window, as ${row.requestedBy} asked.`,
          );
        } else {
          await this.maintenance.settle(row, verdict.status, verdict.outcome);
        }
      } catch (err) {
        await this.maintenance.settle(
          row,
          'failed',
          `Not applied: ${(err as Error).message}`,
        );
      }
    }
    return due.length;
  }
}
