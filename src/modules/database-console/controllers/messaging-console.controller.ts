import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AppOwnershipGuard } from '../guards/app-ownership.guard';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { MessagingQueryService } from '../services/messaging-query.service';
import {
  JsStream,
  MessagingServerInfo,
  PublishResult,
  QueueMessage,
  QueueStream,
} from '../engine/messaging-engine';
import { MessagingConnectionInfo } from '../interfaces/messaging-connection';
import {
  MessagingCreateStreamDto,
  MessagingPeekDto,
  MessagingPublishDto,
} from '../dto/messaging-console.dto';

const DEFAULT_PEEK_LIMIT = 20;

/**
 * Messaging console (NATS/JetStream): read-only monitor (server stats + streams)
 * plus produce (publish) and non-destructive peek of stored messages.
 */
@UseGuards(AppOwnershipGuard)
@Controller('applications/:id/messaging')
export class MessagingConsoleController {
  constructor(private readonly messaging: MessagingQueryService) {}

  @Get('connection-info')
  connectionInfo(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<MessagingConnectionInfo> {
    return this.messaging.connectionInfo({
      appId: id,
      fluiUserId: req.user.userId,
    });
  }

  @Get('server-info')
  serverInfo(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<MessagingServerInfo> {
    return this.messaging.serverInfo({
      appId: id,
      fluiUserId: req.user.userId,
    });
  }

  @Get('streams')
  streams(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<JsStream[]> {
    return this.messaging.streams({ appId: id, fluiUserId: req.user.userId });
  }

  @Post('publish')
  publish(
    @Param('id') id: string,
    @Body() dto: MessagingPublishDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<PublishResult> {
    return this.messaging.publish(
      { appId: id, fluiUserId: req.user.userId },
      { subject: dto.subject, payload: dto.payload, headers: dto.headers },
      { readOnly: dto.readOnly !== false },
    );
  }

  @Post('peek')
  peek(
    @Param('id') id: string,
    @Body() dto: MessagingPeekDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<QueueMessage[]> {
    return this.messaging.peek(
      { appId: id, fluiUserId: req.user.userId },
      {
        stream: dto.stream,
        limit: dto.limit ?? DEFAULT_PEEK_LIMIT,
        startSeq: dto.startSeq,
      },
    );
  }

  /** Create a stream so a subject can be produced to / peeked (write). */
  @Post('streams')
  createStream(
    @Param('id') id: string,
    @Body() dto: MessagingCreateStreamDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<QueueStream> {
    return this.messaging.createStream(
      { appId: id, fluiUserId: req.user.userId },
      {
        name: dto.name,
        subjects: dto.subjects,
        storage: dto.storage,
        retention: dto.retention,
        maxMsgs: dto.maxMsgs,
        maxBytes: dto.maxBytes,
        maxAgeSeconds: dto.maxAgeSeconds,
      },
      { readOnly: dto.readOnly !== false },
    );
  }

  /** Delete a stream and its stored messages (destructive write). */
  @Delete('streams/:name')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  deleteStream(
    @Param('id') id: string,
    @Param('name') name: string,
    @Query('readOnly') readOnly: string | undefined,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<{ ok: true }> {
    return this.messaging
      .deleteStream({ appId: id, fluiUserId: req.user.userId }, name, {
        readOnly: readOnly !== 'false',
      })
      .then(() => ({ ok: true as const }));
  }
}
