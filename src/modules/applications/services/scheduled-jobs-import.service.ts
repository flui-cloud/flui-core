import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { ScheduledJobsService } from './scheduled-jobs.service';

/**
 * Records, once, the schedules that exist only as CronJobs — every schedule
 * made before Flui kept them. In the background: a cluster that does not
 * answer must not hold up the API, and the schedule list adopts what this
 * misses the first time it is opened.
 */
@Injectable()
export class ScheduledJobsImportService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScheduledJobsImportService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly applications: ApplicationsRepository,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
    private readonly schedules: ScheduledJobsService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    void this.importAll().catch((err: Error) =>
      this.logger.warn(`[schedules] import stopped: ${err.message}`),
    );
  }

  async importAll(): Promise<number> {
    let adopted = 0;
    for (const cluster of await this.clusters.find()) {
      if (!cluster.kubeconfigEncrypted) continue;
      const cronJobs = await this.kubernetes
        .listResourcesByLabelEverywhere(
          this.encryption.decrypt(cluster.kubeconfigEncrypted),
          'CronJob',
          'flui.cloud/resource=scheduled-job',
        )
        .catch(() => [] as any[]);
      const byApp = new Map<string, any[]>();
      for (const cron of cronJobs) {
        const appId = cron?.metadata?.labels?.['flui-app-id'];
        if (!appId) continue;
        byApp.set(appId, [...(byApp.get(appId) ?? []), cron]);
      }
      for (const [appId, crons] of byApp) {
        const app = await this.applications.findById(appId);
        if (!app) continue;
        adopted += await this.schedules.adoptUnrecorded(app, crons);
      }
    }
    if (adopted) {
      this.logger.log(`[schedules] recorded ${adopted} existing schedule(s)`);
    }
    return adopted;
  }
}
