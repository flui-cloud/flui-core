import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { ApplicationEntity } from '../entities/application.entity';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import {
  ApplicationManifestGeneratorService,
  CronConcurrencyPolicy,
} from './application-manifest-generator.service';
import { GhcrSecretRefreshService } from './ghcr-secret-refresh.service';
import {
  CreateScheduledJobDto,
  ScheduledJobDto,
  ScheduledJobRunDto,
  UpdateScheduledJobDto,
} from '../dto/scheduled-job.dto';
import { describeRunFailure } from '../utils/run-failure.util';
import {
  SCHEDULED_JOB_LABEL,
  recordToDto,
  resourceName as cronJobName,
  runStartMs,
  runStatus,
  toDto,
  toRunDto,
  withHealth,
} from './scheduled-job-mapping.util';

export { FAILING_AFTER } from './scheduled-job-mapping.util';
import {
  ScheduledJobEntity,
  ScheduledJobOrigin,
} from '../entities/scheduled-job.entity';

const RESOURCE_LABEL = 'flui.cloud/resource';

@Injectable()
export class ScheduledJobsService {
  private readonly logger = new Logger(ScheduledJobsService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly manifestGenerator: ApplicationManifestGeneratorService,
    private readonly ghcrSecretRefresh: GhcrSecretRefreshService,
    @InjectRepository(ScheduledJobEntity)
    private readonly records: Repository<ScheduledJobEntity>,
  ) {}

  async listForApp(appId: string): Promise<ScheduledJobDto[]> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const cronJobs = await this.listCronJobs(app, kubeconfig);
    await this.adoptUnrecorded(app, cronJobs);
    const records = await this.records.find({
      where: { applicationId: app.id },
    });
    const onCluster = new Map(
      cronJobs.map((c) => [c?.metadata?.name as string, c]),
    );
    const runs = await this.kubernetesService
      .listResources(
        kubeconfig,
        'Job',
        app.k8sNamespace,
        `flui-app-id=${app.id},${RESOURCE_LABEL}=scheduled-job`,
      )
      .catch(() => [] as any[]);
    return records
      .map((r) =>
        withHealth(recordToDto(r, onCluster.get(r.resourceName)), runs),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(
    appId: string,
    dto: CreateScheduledJobDto,
  ): Promise<ScheduledJobDto> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const displayName = dto.name;
    const resourceName = cronJobName(app, displayName);

    const recorded = await this.records.findOne({
      where: { applicationId: app.id, name: displayName },
    });
    const existing = await this.kubernetesService.getResource(
      kubeconfig,
      'CronJob',
      resourceName,
      app.k8sNamespace,
    );
    if (recorded || existing) {
      throw new BadRequestException(
        `A schedule named "${displayName}" already exists for this application.`,
      );
    }

    const record = this.records.create({
      applicationId: app.id,
      name: displayName,
      resourceName,
      schedule: dto.schedule,
      command: dto.command,
      timezone: dto.timezone ?? null,
      concurrencyPolicy: dto.concurrencyPolicy ?? 'Forbid',
      enabled: dto.enabled !== false,
      origin: ScheduledJobOrigin.USER,
    });
    // The cluster first: it is the one that refuses a bad schedule, and a
    // record of something it refused would be recreated on every release.
    await this.applyRecord(app, kubeconfig, record);
    const saved = await this.records.save(record);
    return recordToDto(saved, await this.cronOf(app, kubeconfig, saved));
  }

  async update(
    appId: string,
    name: string,
    dto: UpdateScheduledJobDto,
  ): Promise<ScheduledJobDto> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const record = await this.recordOf(app, kubeconfig, name);
    this.assertEditable(record);

    const next = this.records.merge(this.records.create(record), {
      schedule: dto.schedule ?? record.schedule,
      command: dto.command ?? record.command,
      timezone:
        dto.timezone === undefined ? record.timezone : dto.timezone || null,
      concurrencyPolicy: dto.concurrencyPolicy ?? record.concurrencyPolicy,
      enabled: dto.enabled ?? record.enabled,
    });
    await this.applyRecord(app, kubeconfig, next);
    const saved = await this.records.save(next);
    return recordToDto(saved, await this.cronOf(app, kubeconfig, saved));
  }

  /**
   * After a release, every schedule of the application runs the image just
   * deployed; otherwise it would keep the image it was created with.
   */
  async realignImage(appId: string, imageRef: string): Promise<number> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const cronJobs = await this.listCronJobs(app, kubeconfig);
    await this.adoptUnrecorded(app, cronJobs);
    const onCluster = new Map(
      cronJobs.map((c) => [c?.metadata?.name as string, c]),
    );
    const records = await this.records.find({
      where: { applicationId: app.id },
    });
    let realigned = 0;
    for (const record of records) {
      const cron = onCluster.get(record.resourceName);
      const image =
        cron?.spec?.jobTemplate?.spec?.template?.spec?.containers?.[0]?.image;
      // Missing ones too: after a rebuild the cluster has none, and this is
      // what puts them back.
      if (cron && image === imageRef) continue;
      await this.applyRecord(app, kubeconfig, record, imageRef);
      realigned++;
    }
    if (realigned) {
      this.logger.log(
        `[schedules] ${realigned} schedule(s) of ${app.slug} now run ${imageRef}`,
      );
    }
    return realigned;
  }

  async remove(appId: string, name: string): Promise<void> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const record = await this.recordOf(app, kubeconfig, name);
    this.assertEditable(record);
    await this.kubernetesService.deleteResource(
      kubeconfig,
      'CronJob',
      record.resourceName,
      app.k8sNamespace,
    );
    await this.records.delete(record.id);
  }

  async trigger(appId: string, name: string): Promise<{ jobName: string }> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const record = await this.recordOf(app, kubeconfig, name);
    if (!(await this.cronOf(app, kubeconfig, record))) {
      await this.applyRecord(app, kubeconfig, record);
    }
    const jobName = await this.kubernetesService.createJobFromCronJob(
      kubeconfig,
      record.resourceName,
      app.k8sNamespace,
    );
    return { jobName };
  }

  async listRuns(appId: string, name: string): Promise<ScheduledJobRunDto[]> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    await this.recordOf(app, kubeconfig, name);
    const jobs = await this.kubernetesService.listResources(
      kubeconfig,
      'Job',
      app.k8sNamespace,
      `${SCHEDULED_JOB_LABEL}=${name}`,
    );
    const runs: ScheduledJobRunDto[] = [];
    for (const job of jobs) {
      const run = toRunDto(job);
      if (run.status === 'Failed') {
        run.reason = await this.failureOf(kubeconfig, app.k8sNamespace, job);
      }
      runs.push(run);
    }
    return runs.sort((a, b) => runStartMs(b) - runStartMs(a));
  }

  /** Why one run failed, or null when it did not. */
  async getRunFailure(appId: string, jobName: string): Promise<string | null> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const job = await this.kubernetesService.getResource(
      kubeconfig,
      'Job',
      jobName,
      app.k8sNamespace,
    );
    if (!job || runStatus(job.status ?? {}) !== 'Failed') return null;
    return this.failureOf(kubeconfig, app.k8sNamespace, job);
  }

  private async failureOf(
    kubeconfig: string,
    namespace: string,
    job: Record<string, any>,
  ): Promise<string | null> {
    const pods = await this.kubernetesService
      .listPodsByLabel(kubeconfig, namespace, `job-name=${job?.metadata?.name}`)
      .catch(() => [] as any[]);
    return describeRunFailure(job, pods);
  }

  async getRunLogs(
    appId: string,
    name: string,
    jobName: string,
  ): Promise<string> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const pods = await this.kubernetesService.listPodsByLabel(
      kubeconfig,
      app.k8sNamespace,
      `job-name=${jobName}`,
    );
    if (!pods.length) return '';
    const podName = pods[0]?.metadata?.name;
    if (!podName) return '';
    try {
      return await this.kubernetesService.getPodLogs(
        kubeconfig,
        podName,
        app.k8sNamespace,
        app.slug,
        1000,
      );
    } catch (err) {
      this.logger.debug(
        `getRunLogs: no logs for ${jobName} (${(err as Error).message})`,
      );
      return '';
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private async applyCronJob(
    app: ApplicationEntity,
    kubeconfig: string,
    spec: {
      resourceName: string;
      displayName: string;
      schedule: string;
      command: string;
      timezone?: string;
      concurrencyPolicy: CronConcurrencyPolicy;
      suspend: boolean;
    },
    imageRefOverride?: string,
  ): Promise<void> {
    let pullSecretName: string | undefined;
    if (app.sourceType === ApplicationSourceType.GIT_BUILD && app.userId) {
      pullSecretName = await this.ghcrSecretRefresh.ensureSecretForApp(
        kubeconfig,
        app,
      );
    }

    const manifest = this.manifestGenerator.generateCronJob(
      app,
      {
        name: spec.resourceName,
        displayName: spec.displayName,
        schedule: spec.schedule,
        command: spec.command,
        timezone: spec.timezone,
        concurrencyPolicy: spec.concurrencyPolicy,
        suspend: spec.suspend,
      },
      pullSecretName,
      imageRefOverride,
    );

    try {
      await this.kubernetesService.applyManifest(kubeconfig, manifest.yaml);
    } catch (err) {
      // The cluster's answer carries its own request body and headers; it is
      // logged for the operator and never handed to the person.
      this.logger.warn(
        `[schedules] cluster refused ${app.k8sNamespace}/${spec.resourceName}: ${(err as Error).message}`,
      );
      throw new BadRequestException(
        `The cluster refused schedule "${spec.displayName}". Check its schedule, time zone and command, then try again.`,
      );
    }
  }

  private async listCronJobs(
    app: ApplicationEntity,
    kubeconfig: string,
  ): Promise<Record<string, any>[]> {
    return this.kubernetesService.listResourcesByLabel(
      kubeconfig,
      'CronJob',
      app.k8sNamespace,
      `flui-app-id=${app.id},${RESOURCE_LABEL}=scheduled-job`,
    );
  }

  private cronOf(
    app: ApplicationEntity,
    kubeconfig: string,
    record: ScheduledJobEntity,
  ): Promise<Record<string, any> | null> {
    return this.kubernetesService.getResource(
      kubeconfig,
      'CronJob',
      record.resourceName,
      app.k8sNamespace,
    );
  }

  /**
   * Schedules that exist on the cluster with no record: made before Flui
   * kept records, or by a Flui that did not. They are the person's, and
   * recording them is what lets a release or a rebuild keep them.
   */
  async adoptUnrecorded(
    app: ApplicationEntity,
    cronJobs: Record<string, any>[],
  ): Promise<number> {
    if (!cronJobs.length) return 0;
    const known = new Set(
      (
        await this.records.find({
          where: { applicationId: app.id },
          select: ['resourceName'],
        })
      ).map((r) => r.resourceName),
    );
    let adopted = 0;
    for (const cron of cronJobs) {
      const seen = toDto(cron);
      if (!seen.resourceName || known.has(seen.resourceName)) continue;
      await this.records
        .save(
          this.records.create({
            applicationId: app.id,
            name: seen.name,
            resourceName: seen.resourceName,
            schedule: seen.schedule,
            command: seen.command,
            timezone: seen.timezone ?? null,
            concurrencyPolicy: seen.concurrencyPolicy,
            enabled: seen.enabled,
            origin: ScheduledJobOrigin.USER,
          }),
        )
        .then(() => adopted++)
        .catch((err: Error) =>
          this.logger.warn(
            `[schedules] could not record ${app.slug}/${seen.name}: ${err.message}`,
          ),
        );
    }
    return adopted;
  }

  private async recordOf(
    app: ApplicationEntity,
    kubeconfig: string,
    name: string,
  ): Promise<ScheduledJobEntity> {
    const find = () =>
      this.records.findOne({ where: { applicationId: app.id, name } });
    let record = await find();
    if (!record) {
      const cron = await this.kubernetesService.getResource(
        kubeconfig,
        'CronJob',
        cronJobName(app, name),
        app.k8sNamespace,
      );
      if (cron) {
        await this.adoptUnrecorded(app, [cron]);
        record = await find();
      }
    }
    if (!record) {
      throw new NotFoundException(
        `Schedule "${name}" not found for application ${app.id}`,
      );
    }
    return record;
  }

  private assertEditable(record: ScheduledJobEntity): void {
    if (record.origin === ScheduledJobOrigin.MANIFEST) {
      throw new BadRequestException(
        `Schedule "${record.name}" is declared in the application's flui.yaml; change it there and release.`,
      );
    }
  }

  private applyRecord(
    app: ApplicationEntity,
    kubeconfig: string,
    record: ScheduledJobEntity,
    imageRefOverride?: string,
  ): Promise<void> {
    return this.applyCronJob(
      app,
      kubeconfig,
      {
        resourceName: record.resourceName,
        displayName: record.name,
        schedule: record.schedule,
        command: record.command,
        timezone: record.timezone ?? undefined,
        concurrencyPolicy: record.concurrencyPolicy as CronConcurrencyPolicy,
        suspend: !record.enabled,
      },
      imageRefOverride,
    );
  }

  /** `<slug>-<name>`, truncated to a DNS-1123-safe CronJob name length. */

  private async resolveAppAndKubeconfig(
    appId: string,
  ): Promise<{ app: ApplicationEntity; kubeconfig: string }> {
    const app = await this.applicationsRepository.findById(appId);
    if (!app) throw new NotFoundException(`Application ${appId} not found`);

    const cluster = await this.clusterRepository.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new NotFoundException(
        `Cluster ${app.clusterId} has no kubeconfig available`,
      );
    }

    return {
      app,
      kubeconfig: this.encryptionService.decrypt(cluster.kubeconfigEncrypted),
    };
  }
}
