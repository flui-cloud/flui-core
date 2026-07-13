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
  ScheduledJobRunStatus,
  UpdateScheduledJobDto,
} from '../dto/scheduled-job.dto';

const SCHEDULED_JOB_LABEL = 'flui.cloud/scheduled-job';
const RESOURCE_LABEL = 'flui.cloud/resource';
const MAX_CRONJOB_NAME = 52; // Job names append `-<timestamp>` to this (63 cap).

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
  ) {}

  async listForApp(appId: string): Promise<ScheduledJobDto[]> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const cronJobs = await this.kubernetesService.listResourcesByLabel(
      kubeconfig,
      'CronJob',
      app.k8sNamespace,
      `flui-app-id=${app.id},${RESOURCE_LABEL}=scheduled-job`,
    );
    return cronJobs
      .map((c) => this.toDto(c))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(
    appId: string,
    dto: CreateScheduledJobDto,
  ): Promise<ScheduledJobDto> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const displayName = dto.name;
    const resourceName = this.resourceName(app, displayName);

    const existing = await this.kubernetesService.getResource(
      kubeconfig,
      'CronJob',
      resourceName,
      app.k8sNamespace,
    );
    if (existing) {
      throw new BadRequestException(
        `A schedule named "${displayName}" already exists for this application.`,
      );
    }

    await this.applyCronJob(app, kubeconfig, {
      resourceName,
      displayName,
      schedule: dto.schedule,
      command: dto.command,
      timezone: dto.timezone,
      concurrencyPolicy: dto.concurrencyPolicy ?? 'Forbid',
      suspend: dto.enabled === false,
    });

    return this.getOne(app, kubeconfig, resourceName);
  }

  async update(
    appId: string,
    name: string,
    dto: UpdateScheduledJobDto,
  ): Promise<ScheduledJobDto> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const resourceName = this.resourceName(app, name);
    const current = await this.getOne(app, kubeconfig, resourceName);

    await this.applyCronJob(app, kubeconfig, {
      resourceName,
      displayName: current.name,
      schedule: dto.schedule ?? current.schedule,
      command: dto.command ?? current.command,
      timezone: dto.timezone ?? current.timezone,
      concurrencyPolicy: (dto.concurrencyPolicy ??
        current.concurrencyPolicy) as CronConcurrencyPolicy,
      suspend: dto.enabled === undefined ? !current.enabled : !dto.enabled,
    });

    return this.getOne(app, kubeconfig, resourceName);
  }

  async remove(appId: string, name: string): Promise<void> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const resourceName = this.resourceName(app, name);
    // Confirm existence for a clean 404 rather than a silent no-op.
    await this.getOne(app, kubeconfig, resourceName);
    await this.kubernetesService.deleteResource(
      kubeconfig,
      'CronJob',
      resourceName,
      app.k8sNamespace,
    );
  }

  async trigger(appId: string, name: string): Promise<{ jobName: string }> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const resourceName = this.resourceName(app, name);
    await this.getOne(app, kubeconfig, resourceName);
    const jobName = await this.kubernetesService.createJobFromCronJob(
      kubeconfig,
      resourceName,
      app.k8sNamespace,
    );
    return { jobName };
  }

  async listRuns(appId: string, name: string): Promise<ScheduledJobRunDto[]> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const resourceName = this.resourceName(app, name);
    await this.getOne(app, kubeconfig, resourceName);
    const jobs = await this.kubernetesService.listResources(
      kubeconfig,
      'Job',
      app.k8sNamespace,
      `${SCHEDULED_JOB_LABEL}=${name}`,
    );
    return jobs
      .map((j) => this.toRunDto(j))
      .sort((a, b) => this.runStartMs(b) - this.runStartMs(a));
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
    );

    try {
      await this.kubernetesService.applyManifest(kubeconfig, manifest.yaml);
    } catch (err) {
      throw new BadRequestException(
        `Failed to apply schedule "${spec.displayName}": ${(err as Error).message}`,
      );
    }
  }

  private async getOne(
    app: ApplicationEntity,
    kubeconfig: string,
    resourceName: string,
  ): Promise<ScheduledJobDto> {
    const cron = await this.kubernetesService.getResource(
      kubeconfig,
      'CronJob',
      resourceName,
      app.k8sNamespace,
    );
    if (!cron) {
      throw new NotFoundException(
        `Schedule "${resourceName}" not found for application ${app.id}`,
      );
    }
    return this.toDto(cron);
  }

  /** `<slug>-<name>`, truncated to a DNS-1123-safe CronJob name length. */
  private resourceName(app: ApplicationEntity, name: string): string {
    const sanitized = name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '');
    return `${app.slug}-${sanitized}`.slice(0, MAX_CRONJOB_NAME);
  }

  private toDto(cron: Record<string, any>): ScheduledJobDto {
    const meta = cron?.metadata ?? {};
    const spec = cron?.spec ?? {};
    const status = cron?.status ?? {};
    const container = spec?.jobTemplate?.spec?.template?.spec?.containers?.[0];
    const args: string[] = container?.args ?? [];

    return {
      name: meta?.labels?.[SCHEDULED_JOB_LABEL] ?? meta?.name ?? '',
      resourceName: meta?.name ?? '',
      schedule: spec?.schedule ?? '',
      command: args.length ? args[args.length - 1] : '',
      timezone: spec?.timeZone ?? undefined,
      concurrencyPolicy: (spec?.concurrencyPolicy ??
        'Forbid') as ScheduledJobDto['concurrencyPolicy'],
      enabled: spec?.suspend !== true,
      activeRuns: Array.isArray(status?.active) ? status.active.length : 0,
      lastScheduleTime: status?.lastScheduleTime ?? null,
      lastSuccessfulTime: status?.lastSuccessfulTime ?? null,
      createdAt: meta?.creationTimestamp ?? null,
    };
  }

  private toRunDto(job: Record<string, any>): ScheduledJobRunDto {
    const meta = job?.metadata ?? {};
    const status = job?.status ?? {};
    return {
      jobName: meta?.name ?? '',
      status: this.runStatus(status),
      manual: meta?.labels?.['flui.cloud/manual-run'] === 'true',
      startTime: status?.startTime ?? null,
      completionTime: status?.completionTime ?? null,
    };
  }

  private runStatus(status: Record<string, any>): ScheduledJobRunStatus {
    if (status?.succeeded) return 'Succeeded';
    if (status?.failed) return 'Failed';
    if (status?.active) return 'Running';
    return 'Unknown';
  }

  private runStartMs(run: ScheduledJobRunDto): number {
    return run.startTime ? Date.parse(run.startTime) : 0;
  }

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
