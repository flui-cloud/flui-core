import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AppAccessGuard } from '../guards/app-access.guard';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { ScheduledJobsService } from '../services/scheduled-jobs.service';
import {
  CreateScheduledJobDto,
  ScheduledJobDto,
  ScheduledJobRunDto,
  ScheduledJobRunLogsDto,
  TriggerScheduledJobResponseDto,
  UpdateScheduledJobDto,
} from '../dto/scheduled-job.dto';

@ApiTags('Scheduled Jobs')
@ApiBearerAuth()
@UseGuards(AppAccessGuard)
@Controller('applications/:id/schedules')
export class ScheduledJobsController {
  constructor(private readonly scheduledJobs: ScheduledJobsService) {}

  @Get()
  @ApiOperation({
    summary: 'List scheduled jobs',
    description:
      'Returns the cron schedules attached to an application. Each runs the app image + env on a cron schedule as a Kubernetes CronJob.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 200, type: [ScheduledJobDto] })
  async list(@Param('id') appId: string): Promise<ScheduledJobDto[]> {
    return this.scheduledJobs.listForApp(appId);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a scheduled job',
    description:
      'Creates a cron schedule that runs a command against the application image + env. Concurrency defaults to Forbid.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 201, type: ScheduledJobDto })
  async create(
    @Param('id') appId: string,
    @Body() dto: CreateScheduledJobDto,
  ): Promise<ScheduledJobDto> {
    return this.scheduledJobs.create(appId, dto);
  }

  @Patch(':name')
  @ApiOperation({
    summary: 'Update a scheduled job',
    description:
      'Updates the schedule, command, timezone, concurrency or enabled state. Only provided fields change.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({ name: 'name', description: 'Schedule name' })
  @ApiResponse({ status: 200, type: ScheduledJobDto })
  async update(
    @Param('id') appId: string,
    @Param('name') name: string,
    @Body() dto: UpdateScheduledJobDto,
  ): Promise<ScheduledJobDto> {
    return this.scheduledJobs.update(appId, name, dto);
  }

  @Delete(':name')
  @ActionCycle({
    action: 'DELETE /applications/:id/schedules/:name',
    bind: ['id', 'name'],
    sentence:
      'delete the scheduled job {name} of application {id}, so it never runs ' +
      'again',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a scheduled job' })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({ name: 'name', description: 'Schedule name' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  async remove(
    @Param('id') appId: string,
    @Param('name') name: string,
  ): Promise<void> {
    await this.scheduledJobs.remove(appId, name);
  }

  @Post(':name/trigger')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trigger a scheduled job now',
    description:
      'Manually instantiates a one-off run from the schedule, independent of its cron timing.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({ name: 'name', description: 'Schedule name' })
  @ApiResponse({ status: 200, type: TriggerScheduledJobResponseDto })
  async trigger(
    @Param('id') appId: string,
    @Param('name') name: string,
  ): Promise<TriggerScheduledJobResponseDto> {
    return this.scheduledJobs.trigger(appId, name);
  }

  @Get(':name/runs')
  @ApiOperation({
    summary: 'List runs of a scheduled job',
    description:
      'Returns the recent Job runs (kept per the CronJob history limits) with their status.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({ name: 'name', description: 'Schedule name' })
  @ApiResponse({ status: 200, type: [ScheduledJobRunDto] })
  async runs(
    @Param('id') appId: string,
    @Param('name') name: string,
  ): Promise<ScheduledJobRunDto[]> {
    return this.scheduledJobs.listRuns(appId, name);
  }

  @Get(':name/runs/:jobName/logs')
  @ApiOperation({ summary: 'Read logs for a single run' })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({ name: 'name', description: 'Schedule name' })
  @ApiParam({ name: 'jobName', description: 'Job resource name of the run' })
  @ApiResponse({ status: 200, type: ScheduledJobRunLogsDto })
  async runLogs(
    @Param('id') appId: string,
    @Param('name') name: string,
    @Param('jobName') jobName: string,
  ): Promise<ScheduledJobRunLogsDto> {
    const logs = await this.scheduledJobs.getRunLogs(appId, name, jobName);
    return { jobName, logs };
  }
}
