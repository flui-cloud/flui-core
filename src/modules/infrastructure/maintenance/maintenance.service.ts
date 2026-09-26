import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository } from 'typeorm';
import { ClusterEntity } from '../clusters/entities/cluster.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { AppRevisionsRepository } from '../../applications/repositories/app-revisions.repository';
import {
  AppEventActorType,
  AppEventType,
} from '../../applications/enums/app-event-type.enum';
import {
  AppMaintenance,
  MaintenanceWindow,
  describeWindow,
  effectiveWindow,
  nextOpening,
  windowProblems,
} from './maintenance-window.core';
import {
  DeferredActionEntity,
  DeferredActionKind,
  DeferredActionStatus,
} from './deferred-action.entity';
import {
  AppMaintenanceDto,
  ClusterMaintenanceDto,
  DeferredActionDto,
  SetAppMaintenanceDto,
} from './maintenance.dto';

const SAYS: Record<DeferredActionKind, string> = {
  'apply-resource-proposal': 'Apply the memory change Flui proposes',
};

@Injectable()
export class MaintenanceService {
  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    @InjectRepository(DeferredActionEntity)
    private readonly deferred: Repository<DeferredActionEntity>,
    private readonly revisions: AppRevisionsRepository,
  ) {}

  async clusterWindow(clusterId: string): Promise<ClusterMaintenanceDto> {
    const cluster = await this.cluster(clusterId);
    const window = cluster.maintenanceWindow ?? null;
    const next = window ? nextOpening(window, new Date()) : null;
    return {
      window,
      nextOpening: next?.toISOString() ?? null,
      says: window
        ? `Open ${describeWindow(window)}.`
        : 'No maintenance window: changes that restart something can only be applied now.',
    };
  }

  async setClusterWindow(
    clusterId: string,
    window: MaintenanceWindow,
  ): Promise<ClusterMaintenanceDto> {
    const problems = windowProblems(window);
    if (problems.length) throw new BadRequestException(problems.join(' '));
    await this.cluster(clusterId);
    await this.clusters.update(clusterId, {
      maintenanceWindow: window as never,
    });
    return this.clusterWindow(clusterId);
  }

  async clearClusterWindow(clusterId: string): Promise<ClusterMaintenanceDto> {
    await this.cluster(clusterId);
    await this.clusters.update(clusterId, { maintenanceWindow: null as never });
    return this.clusterWindow(clusterId);
  }

  async appMaintenance(appId: string): Promise<AppMaintenanceDto> {
    const app = await this.app(appId);
    const cluster = await this.cluster(app.clusterId);
    const setting: AppMaintenance = app.maintenance ?? { mode: 'follow' };
    const effective = effectiveWindow(cluster.maintenanceWindow, setting);
    const now = new Date();
    if (effective.kind === 'anytime') {
      return {
        mode: setting.mode,
        window: null,
        nextOpening: now.toISOString(),
        says: 'Takes such changes at any time.',
      };
    }
    if (effective.kind === 'none') {
      return {
        mode: setting.mode,
        window: setting.window ?? null,
        nextOpening: null,
        says: effective.reason,
      };
    }
    return {
      mode: setting.mode,
      window: setting.window ?? null,
      nextOpening: nextOpening(effective.window, now)?.toISOString() ?? null,
      says:
        effective.source === 'app'
          ? `Its own window: ${describeWindow(effective.window)}.`
          : `Follows the cluster: ${describeWindow(effective.window)}.`,
    };
  }

  async setAppMaintenance(
    appId: string,
    dto: SetAppMaintenanceDto,
  ): Promise<AppMaintenanceDto> {
    await this.app(appId);
    if (dto.mode === 'own') {
      if (!dto.window)
        throw new BadRequestException('An own window needs its slots.');
      const problems = windowProblems(dto.window);
      if (problems.length) throw new BadRequestException(problems.join(' '));
    }
    const value: AppMaintenance | null =
      dto.mode === 'follow'
        ? null
        : { mode: dto.mode, window: dto.mode === 'own' ? dto.window : null };
    await this.applications.update(appId, { maintenance: value as never });
    return this.appMaintenance(appId);
  }

  /** Holds an action until the app's next opening; refused, with the reason, when it has none. */
  async defer(
    kind: DeferredActionKind,
    appId: string,
    requestedBy: string,
    payload: Record<string, unknown> = {},
  ): Promise<DeferredActionDto> {
    const app = await this.app(appId);
    const reading = await this.appMaintenance(appId);
    if (!reading.nextOpening) throw new ConflictException(reading.says);
    const saved = await this.deferred.save(
      this.deferred.create({
        kind,
        clusterId: app.clusterId,
        applicationId: app.id,
        requestedBy,
        runAt: new Date(reading.nextOpening),
        status: 'pending',
        payload,
      }),
    );
    await this.log(
      app.id,
      requestedBy,
      `${SAYS[kind]} held for the maintenance window at ${saved.runAt.toISOString()}.`,
      {
        deferredActionId: saved.id,
        status: 'pending',
      },
    );
    return this.toDto(saved, app.name);
  }

  async list(filter: {
    clusterId?: string;
    applicationId?: string;
    pendingOnly?: boolean;
  }): Promise<DeferredActionDto[]> {
    const rows = await this.deferred.find({
      where: {
        ...(filter.clusterId ? { clusterId: filter.clusterId } : {}),
        ...(filter.applicationId
          ? { applicationId: filter.applicationId }
          : {}),
        ...(filter.pendingOnly
          ? { status: 'pending' as DeferredActionStatus }
          : {}),
      },
      order: { runAt: 'ASC' },
      take: 100,
    });
    const names = await this.appNames(rows);
    return rows.map((row) =>
      this.toDto(row, names.get(row.applicationId ?? '') ?? null),
    );
  }

  async get(id: string): Promise<DeferredActionEntity> {
    const row = await this.deferred.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Deferred action ${id} not found`);
    return row;
  }

  async cancel(id: string, by: string): Promise<DeferredActionDto> {
    const row = await this.get(id);
    if (row.status !== 'pending') {
      throw new ConflictException(
        `It is already ${row.status}; only a waiting action can be cancelled.`,
      );
    }
    return this.settle(
      row,
      'cancelled',
      `Cancelled by ${by} before the window opened.`,
      by,
    );
  }

  /** Every held action whose opening has come. */
  due(now = new Date()): Promise<DeferredActionEntity[]> {
    return this.deferred.find({
      where: { status: 'pending', runAt: LessThanOrEqual(now) },
      order: { runAt: 'ASC' },
      take: 50,
    });
  }

  async settle(
    row: DeferredActionEntity,
    status: Exclude<DeferredActionStatus, 'pending'>,
    outcome: string,
    by = 'Flui',
  ): Promise<DeferredActionDto> {
    await this.deferred.update(row.id, {
      status,
      outcome,
      settledAt: new Date(),
    });
    if (row.applicationId) {
      await this.log(row.applicationId, by, outcome, {
        deferredActionId: row.id,
        status,
      });
    }
    const fresh = await this.get(row.id);
    const names = await this.appNames([fresh]);
    return this.toDto(fresh, names.get(fresh.applicationId ?? '') ?? null);
  }

  private async log(
    appId: string,
    by: string,
    sentence: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.revisions.createAuditEvent({
      applicationId: appId,
      eventType: AppEventType.MAINTENANCE,
      actor:
        by === 'Flui'
          ? { type: AppEventActorType.SCHEDULER }
          : { type: AppEventActorType.USER, name: by },
      changeMetadata: { reason: sentence, ...extra },
    });
  }

  private async appNames(
    rows: DeferredActionEntity[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        rows.map((r) => r.applicationId).filter((id): id is string => !!id),
      ),
    ];
    if (!ids.length) return new Map();
    const apps = await this.applications.find({
      where: { id: In(ids) },
      select: { id: true, name: true },
    });
    return new Map(apps.map((a) => [a.id, a.name]));
  }

  private toDto(
    row: DeferredActionEntity,
    applicationName: string | null,
  ): DeferredActionDto {
    return {
      id: row.id,
      kind: row.kind,
      clusterId: row.clusterId,
      applicationId: row.applicationId,
      applicationName,
      requestedBy: row.requestedBy,
      requestedAt: row.requestedAt.toISOString(),
      runAt: row.runAt.toISOString(),
      status: row.status,
      outcome: row.outcome,
      says: `${SAYS[row.kind]}${applicationName ? ' of ' + applicationName : ''}.`,
    };
  }

  private async cluster(id: string): Promise<ClusterEntity> {
    const cluster = await this.clusters.findOne({ where: { id } });
    if (!cluster) throw new NotFoundException(`Cluster ${id} not found`);
    return cluster;
  }

  private async app(id: string): Promise<ApplicationEntity> {
    const app = await this.applications.findOne({ where: { id } });
    if (!app) throw new NotFoundException(`Application ${id} not found`);
    return app;
  }
}
