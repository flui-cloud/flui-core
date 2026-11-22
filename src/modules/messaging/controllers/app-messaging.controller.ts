import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { AppMessagingService } from '../services/app-messaging.service';
import {
  AppMessagingDto,
  CreateQueueDto,
  QueueScalingDto,
  QueueViewDto,
} from '../dto/app-messaging.dto';
import { AppQueuesService } from '../services/app-queues.service';

const userOf = (req: Request) => req.user as AuthenticatedUser;

@ApiTags('Messaging')
@ApiBearerAuth()
@Controller('applications/:id/messaging')
export class AppMessagingController {
  constructor(
    private readonly messaging: AppMessagingService,
    private readonly queues: AppQueuesService,
  ) {}

  @Get('queues')
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary:
      'The queues in an application’s NATS account, with what waits in each',
  })
  @ApiResponse({ status: 200, type: [QueueViewDto] })
  listQueues(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<QueueViewDto[]> {
    return this.queues.list(userOf(req), id);
  }

  @Post('queues')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @ApiOperation({
    summary: 'Create a queue in an application’s NATS account',
    description:
      'A work-queue stream on NAME and NAME.>, one durable consumer NAME the worker pulls from, and with deadLetter a NAME_DLQ stream that records the messages given up on after maxDeliver deliveries.',
  })
  @ApiResponse({ status: 201, type: [QueueViewDto] })
  createQueue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateQueueDto,
    @Req() req: Request,
  ): Promise<QueueViewDto[]> {
    return this.queues.create(userOf(req), id, dto);
  }

  @Delete('queues/:name')
  @RequirePermission(IAM_PERMISSION.APP_DELETE)
  @ActionCycle({
    action: 'DELETE /applications/:id/messaging/queues/:name',
    bind: ['id', 'name'],
    sentence: 'delete queue {name} of application {id}, with its messages',
    consequence:
      'The queue, its dead letters and every message in them are gone; the application’s other queues are unaffected.',
  })
  @ApiOperation({
    summary: 'Delete a queue and its dead letters, with every message in them',
  })
  @ApiResponse({ status: 200, type: [QueueViewDto] })
  deleteQueue(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('name') name: string,
    @Req() req: Request,
  ): Promise<QueueViewDto[]> {
    return this.queues.remove(userOf(req), id, name);
  }

  @Get()
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'Whether an application has its account on its cluster’s NATS',
  })
  @ApiResponse({ status: 200, type: AppMessagingDto })
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<AppMessagingDto> {
    return this.messaging.get(userOf(req), id);
  }

  @Put()
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @ApiOperation({
    summary: 'Give an application its own account on its cluster’s NATS',
    description:
      'Puts the cluster’s NATS in place if it is not yet, makes an account only this application sees, and hands the application NATS_URL and NATS_CREDS (a credentials file, secret), then redeploys it.',
  })
  @ApiResponse({ status: 200, type: AppMessagingDto })
  connect(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<AppMessagingDto> {
    return this.messaging.connect(userOf(req), id);
  }

  @Put('scaling')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @ApiOperation({
    summary: 'Scale an application on its queue',
    description:
      'Adds replicas while the consumer’s backlog grows past lagThreshold per replica, up to max, and goes down to min — zero included — when it is empty. Needs the application’s NATS account; installs KEDA on the cluster when it is missing.',
  })
  @ApiResponse({ status: 200, type: AppMessagingDto })
  scale(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QueueScalingDto,
    @Req() req: Request,
  ): Promise<AppMessagingDto> {
    return this.messaging.scaleOnQueue(userOf(req), id, dto);
  }

  @Delete('scaling')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @ApiOperation({ summary: 'Stop scaling an application on its queue' })
  @ApiResponse({ status: 200, type: AppMessagingDto })
  stopScaling(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<AppMessagingDto> {
    return this.messaging.stopQueueScaling(userOf(req), id);
  }

  @Delete()
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Take an application’s account off its cluster’s NATS',
  })
  async disconnect(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.messaging.disconnect(userOf(req), id);
  }
}
