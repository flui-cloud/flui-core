import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AlertEventsService } from '../services/alert-events.service';
import { AlertEventEntity } from '../entities/alert-event.entity';
import { ApplicationService } from '../../applications/services/application.service';
import { ApplicationAccessService } from '../../applications/services/application-access.service';
import { AppAccessGuard } from '../../applications/guards/app-access.guard';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import {
  AlertEventDto,
  AlertEventsQueryDto,
  AlertEventsResponseDto,
} from '../dto/alert-event.dto';

/**
 * Reads the alert history Alertmanager reported.
 *
 * Evaluation, grouping and silencing stay in Alertmanager; this is the record, gated
 * by the same access rules as the rest of an application's observability.
 */
@ApiTags('Alerts')
@ApiBearerAuth()
@Controller('observability')
export class AlertEventsController {
  constructor(
    private readonly alertEvents: AlertEventsService,
    private readonly applicationService: ApplicationService,
    private readonly applicationAccess: ApplicationAccessService,
  ) {}

  @Get('applications/:id/alerts')
  @UseGuards(AppAccessGuard)
  @ApiOperation({
    summary: 'Get alerts for an application',
    description:
      'Alert episodes for a single application, newest first. One row per episode: ' +
      'the repeats Alertmanager sends while a condition persists update the row rather ' +
      'than adding to it.',
  })
  @ApiParam({ name: 'id', description: 'Application ID (UUID)' })
  @ApiResponse({ status: 200, type: AlertEventsResponseDto })
  async getApplicationAlerts(
    @Param('id') appId: string,
    @Query() query: AlertEventsQueryDto,
  ): Promise<AlertEventsResponseDto> {
    const app = await this.applicationService.findById(appId);
    const rows = await this.alertEvents.listByApplication(app.id, {
      status: query.status,
      limit: query.limit,
    });
    return this.toResponse(rows);
  }

  @Get('clusters/:clusterId/alerts')
  @ApiOperation({
    summary: 'Get application alerts in a cluster',
    description:
      'Alerts for the applications in the cluster that the caller may read. ' +
      'Infrastructure alerts are not included here — see the admin endpoint.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID (UUID)' })
  @ApiResponse({ status: 200, type: AlertEventsResponseDto })
  async getClusterAlerts(
    @Param('clusterId') clusterId: string,
    @Query() query: AlertEventsQueryDto,
    @Req() req: Request,
  ): Promise<AlertEventsResponseDto> {
    const user = req.user as AuthenticatedUser | undefined;
    const apps = await this.applicationService.findByClusterId(clusterId);
    const readable = user
      ? await this.applicationAccess.filterReadable(user, apps)
      : [];

    const rows = await this.alertEvents.listByApplications(
      readable.map((app) => app.id),
      { status: query.status, limit: query.limit },
    );
    return this.toResponse(rows);
  }

  /**
   * Admin-only, and deliberately a separate route rather than a flag on the others:
   * infrastructure annotations carry node hostnames and internal service ids, which
   * are exactly the things a tenant should not be able to enumerate.
   */
  @Get('alerts/infrastructure')
  @ApiOperation({
    summary: 'Get infrastructure alerts',
    description:
      'Node alerts and any alert whose subject could not be attributed to an ' +
      'application. Requires an administrator.',
  })
  @ApiResponse({ status: 200, type: AlertEventsResponseDto })
  @ApiResponse({ status: 403, description: 'Not an administrator' })
  async getInfrastructureAlerts(
    @Query() query: AlertEventsQueryDto,
    @Req() req: Request,
  ): Promise<AlertEventsResponseDto> {
    const user = req.user as AuthenticatedUser | undefined;
    if (!user?.isAdmin) {
      throw new ForbiddenException(
        'Infrastructure alerts require an administrator',
      );
    }
    const rows = await this.alertEvents.listInfrastructure({
      status: query.status,
      limit: query.limit,
    });
    return this.toResponse(rows);
  }

  private toResponse(rows: AlertEventEntity[]): AlertEventsResponseDto {
    return {
      alerts: rows.map((row) => this.toDto(row)),
      firing: rows.filter((row) => row.status === 'firing').length,
      queried_at: new Date().toISOString(),
    };
  }

  private toDto(row: AlertEventEntity): AlertEventDto {
    return {
      id: row.id,
      status: row.status,
      resolved_by: row.resolvedBy ?? null,
      alertname: row.alertname,
      severity: row.severity,
      flui_kind: row.fluiKind ?? null,
      summary: row.annotations?.summary ?? row.alertname,
      description: row.annotations?.description ?? null,
      application_id: row.applicationId ?? null,
      application_slug: row.applicationSlug ?? null,
      namespace: row.namespace ?? null,
      cluster_id: row.clusterId ?? null,
      node_instance: row.nodeInstance ?? null,
      starts_at: row.startsAt.toISOString(),
      ends_at: row.endsAt ? row.endsAt.toISOString() : null,
      last_seen_at: row.lastSeenAt.toISOString(),
    };
  }
}
