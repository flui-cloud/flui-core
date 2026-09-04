import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, IsNull, Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { VolumePauseLeaseService } from '../services/volume-pause-lease.service';

/**
 * Brings back applications a volume copy stopped and never started again.
 *
 * This is the half of `--pause` that makes it safe to offer. The copy path
 * restores the workload itself as soon as the copy ends, so in the ordinary
 * case this sweeper finds nothing — it exists for the cases where that path
 * never ran: the API killed mid-copy, the node it ran on lost, a deploy in the
 * middle of a backup. Without it, the failure mode of a backup is an
 * application that stays down until somebody notices, which is worse than any
 * copy it was trying to protect.
 *
 * Three triggers, deliberately overlapping. At boot, every lease is stale by
 * definition: whatever copy held it died with the process that started it, so
 * they are all released without waiting for a TTL. On shutdown, the same, while
 * there is still a process to do it. And on a cadence, only leases past their
 * TTL, since a lease inside it may belong to a copy running right now.
 */
@Injectable()
export class VolumePauseSweeperService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(VolumePauseSweeperService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly encryptionService: EncryptionService,
    private readonly pauseLease: VolumePauseLeaseService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.sweepEverywhere(true, 'boot');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.sweepEverywhere(true, 'shutdown');
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweepExpired(): Promise<void> {
    await this.sweepEverywhere(false, 'cadence');
  }

  private async sweepEverywhere(force: boolean, reason: string): Promise<void> {
    let clusters: ClusterEntity[];
    try {
      clusters = await this.clusterRepository.find({
        where: { kubeconfigEncrypted: Not(IsNull()) },
      });
    } catch (err: any) {
      this.logger.warn(
        `[pause-sweep] could not list clusters: ${err?.message}`,
      );
      return;
    }

    for (const cluster of clusters) {
      try {
        const kubeconfig = this.encryptionService.decrypt(
          cluster.kubeconfigEncrypted as string,
        );
        const released = await this.pauseLease.sweep(kubeconfig, force);
        if (released > 0) {
          this.logger.warn(
            `[pause-sweep] ${reason}: restored ${released} workload(s) on cluster ${cluster.id}`,
          );
        }
      } catch (err: any) {
        // One unreachable cluster must not stop the others: the whole point is
        // that something always gets the application back.
        this.logger.warn(
          `[pause-sweep] ${reason}: cluster ${cluster.id} failed: ${err?.message}`,
        );
      }
    }
  }
}
