import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Not, IsNull, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import {
  PauseSweep,
  VolumePauseLeaseService,
} from '../services/volume-pause-lease.service';
import { instanceOfApplicationName } from '../../../common/instance/api-instance';

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
 * Three triggers, deliberately overlapping, and none of them touches a pause
 * another copy of the API may still be using. At boot and on a cadence, the
 * pauses whose copy no longer has a session on the database, and any past the
 * TTL. On shutdown, this copy's own, while there is still a process to do it.
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
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Started, never awaited: this runs before `app.listen()` and talks to every
   * cluster. A powered-off host swallows the packets for ~133s and the
   * liveness probe kills at 90, so one dead cluster stopped the control plane
   * from ever restarting. The sweep still runs; it just no longer gates the port.
   */
  onApplicationBootstrap(): void {
    void this.sweepEverywhere('orphaned', 'boot').catch((err: Error) => {
      this.logger.warn(`[pause-sweep] boot sweep failed: ${err.message}`);
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.sweepEverywhere('mine', 'shutdown');
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweepExpired(): Promise<void> {
    await this.sweepEverywhere('orphaned', 'cadence');
  }

  private async sweepEverywhere(
    mode: 'orphaned' | 'mine',
    reason: string,
  ): Promise<void> {
    let which: PauseSweep = { mode: 'expired' };
    if (mode === 'mine') which = { mode: 'mine' };
    else {
      const alive = await this.aliveCopies();
      if (alive) which = { mode: 'orphaned', alive };
    }
    let clusters: ClusterEntity[];
    try {
      clusters = await this.clusterRepository.find({
        where: {
          kubeconfigEncrypted: Not(IsNull()),
          // A destroyed cluster keeps its kubeconfig, so without this the sweep
          // goes on dialling machines that no longer exist, paying a connect
          // timeout for each one on every pass.
          deletedAt: IsNull(),
          // No lease to release, and asking costs the full connect timeout.
          status: Not(In([ClusterStatus.LOST, ClusterStatus.STOPPED])),
        },
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
        const released = await this.pauseLease.sweep(kubeconfig, which);
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

  /** The copies of the API with a session on the database; null when that cannot be read. */
  private async aliveCopies(): Promise<Set<string> | null> {
    try {
      const rows: Array<{ application_name: string }> =
        await this.dataSource.query(
          `SELECT DISTINCT application_name FROM pg_stat_activity WHERE application_name LIKE 'flui-api:%'`,
        );
      return new Set(
        rows
          .map((r) => instanceOfApplicationName(r.application_name))
          .filter((id): id is string => Boolean(id)),
      );
    } catch {
      return null;
    }
  }
}
