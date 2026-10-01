import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClusterProtectionService } from '../services/cluster-protection.service';

/**
 * The backstop for "every application, including new ones": an application
 * created by any path — a deploy, a catalog install, a restore — is given its
 * policy by the next pass even if nothing told the protection about it.
 */
@Injectable()
export class ClusterProtectionScheduler {
  private readonly logger = new Logger(ClusterProtectionScheduler.name);

  constructor(private readonly protection: ClusterProtectionService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweep(): Promise<void> {
    const clusterIds = await this.protection.protectedClusterIds();
    for (const clusterId of clusterIds) {
      try {
        await this.protection.reconcile(clusterId, { runFirstBackup: true });
      } catch (err: any) {
        this.logger.warn(
          `[protect-cluster] sweep of ${clusterId} failed: ${err?.message}`,
        );
      }
    }
  }
}
