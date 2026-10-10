import { CacheService } from '../../common/cache/cache.service';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { AlertEventsService } from '../../observability/services/alert-events.service';
import { AlertRoutingService } from '../../observability/services/alert-routing.service';
import { parseMemoryMB } from '../../topology/services/topology-k8s.helper';
import {
  FLUI_REGISTRY_CONFIG,
  FluiRegistryConfig,
} from '../flui-registry.config';
import { FluiRegistryClientService } from './flui-registry-client.service';

const GIB = 1024 ** 3;
const USAGE_KEY = 'registry:usage';

export interface RegistryApplicationUsage {
  applicationId: string;
  name: string;
  bytes: number;
}

export interface RegistryUsage {
  measuredAt: Date;
  /** Every layer once, however many applications share it: what the registry keeps. */
  totalBytes: number;
  /** Where the alert is raised; null when it is turned off. */
  alertBytes: number | null;
  /** The volume's size; null on a bucket, which never fills. */
  capacityBytes: number | null;
  alerting: boolean;
  /** Largest first; an application's shared layers count in each one that uses them. */
  applications: RegistryApplicationUsage[];
  /** Applications whose images could not be read on this pass. */
  unreadable: number;
}

/**
 * The space the instance registry takes, and the alert when it takes too much:
 * on a volume because it fills, on a bucket because it is paid by the GiB.
 * Measured from the images themselves, so it reads the same on both.
 */
@Injectable()
export class RegistryUsageService {
  static readonly ALERTNAME = 'FluiRegistrySpace';
  private static readonly FINGERPRINT = 'flui-registry-space';
  private readonly logger = new Logger(RegistryUsageService.name);

  constructor(
    @Inject(FLUI_REGISTRY_CONFIG) private readonly config: FluiRegistryConfig,
    private readonly client: FluiRegistryClientService,
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    private readonly cache: CacheService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  @Cron(process.env.FLUI_REGISTRY_USAGE_CRON || '*/30 * * * *')
  async tick(): Promise<void> {
    if (this.config.mode !== 'flui') return;
    try {
      await this.alertOn(await this.measure());
    } catch (error) {
      this.logger.warn(
        `Could not measure the registry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The last measurement, or a new one when there is none yet. */
  /** The last measurement any copy of the API took, or a new one when there is none. */
  async current(): Promise<RegistryUsage> {
    const shared = await this.cache.get<RegistryUsage>(USAGE_KEY);
    return shared
      ? { ...shared, measuredAt: new Date(shared.measuredAt) }
      : this.measure();
  }

  async measure(): Promise<RegistryUsage> {
    const owners = await this.applications.find({
      where: { imageRegistryHost: Not(IsNull()), deletedAt: IsNull() },
      select: { id: true, name: true },
    });
    const everyBlob = new Map<string, number>();
    const applications: RegistryApplicationUsage[] = [];
    let unreadable = 0;
    for (const app of owners) {
      try {
        const blobs = await this.client.repositoryBlobs(app.id);
        let bytes = 0;
        for (const [digest, size] of blobs) {
          bytes += size;
          everyBlob.set(digest, size);
        }
        if (bytes > 0) {
          applications.push({ applicationId: app.id, name: app.name, bytes });
        }
      } catch {
        unreadable += 1;
      }
    }
    let totalBytes = 0;
    for (const size of everyBlob.values()) totalBytes += size;
    applications.sort((a, b) => b.bytes - a.bytes);

    const capacityBytes =
      this.config.storageBackend === 'filesystem'
        ? parseMemoryMB(this.config.storage) * 1024 * 1024
        : null;
    const alertBytes = this.alertThreshold(capacityBytes);
    const usage: RegistryUsage = {
      measuredAt: new Date(),
      totalBytes,
      alertBytes,
      capacityBytes,
      alerting: alertBytes !== null && totalBytes >= alertBytes,
      applications,
      unreadable,
    };
    await this.cache.set(USAGE_KEY, usage, { ttl: 2 * 3600 });
    return usage;
  }

  private alertThreshold(capacityBytes: number | null): number | null {
    if (capacityBytes !== null) {
      return this.config.spaceAlertPercent > 0 && capacityBytes > 0
        ? Math.floor((capacityBytes * this.config.spaceAlertPercent) / 100)
        : null;
    }
    return this.config.spaceAlertGib > 0
      ? Math.floor(this.config.spaceAlertGib * GIB)
      : null;
  }

  /**
   * Repeated on every pass while it holds, so the stale sweep never closes it;
   * the recorder tells the people once, and once more when it clears.
   */
  async alertOn(usage: RegistryUsage): Promise<void> {
    const recorder = this.moduleRef?.get(AlertEventsService, { strict: false });
    const routing = this.moduleRef?.get(AlertRoutingService, { strict: false });
    if (!recorder || !routing || usage.alertBytes === null) return;

    const since = (
      await recorder.openEpisodes(RegistryUsageService.FINGERPRINT)
    ).get(RegistryUsageService.FINGERPRINT);
    if (!usage.alerting && !since) return;

    const now = new Date();
    const used = gib(usage.totalBytes);
    const limit = gib(usage.alertBytes);
    const onVolume = usage.capacityBytes !== null;
    const transitions = await recorder.record([
      {
        fingerprint: RegistryUsageService.FINGERPRINT,
        status: usage.alerting ? 'firing' : 'resolved',
        startsAt: since ?? now,
        endsAt: usage.alerting ? null : now,
        alertname: RegistryUsageService.ALERTNAME,
        severity: 'warning',
        fluiKind: 'registry',
        labels: {},
        annotations: {
          summary: usage.alerting
            ? `The image registry keeps ${used} GiB, over the ${limit} GiB alert`
            : `The image registry is back under its alert: ${used} GiB of ${limit} GiB`,
          description: onVolume
            ? `Its volume holds ${gib(usage.capacityBytes ?? 0)} GiB; once full, builds can no longer push images.`
            : 'Its bucket never fills, but every GiB kept is paid for.',
          action:
            'See which applications take the most space on the registry page, delete old versions or applications, or keep fewer versions per application.',
        },
      },
    ]);
    for (const { kind, event } of transitions) {
      await routing.deliver(kind, event, { ownerUserId: null });
    }
  }
}

const gib = (bytes: number): string => (bytes / GIB).toFixed(2);
