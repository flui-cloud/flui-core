import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AppOwnershipGuard } from '../guards/app-ownership.guard';
import { PlatformFoundationGuard } from '../guards/platform-foundation.guard';
import {
  ClusterInfo,
  CommandResult,
  GroupSummary,
  TopicSummary,
} from '../../../kafka-client';
import { KafkaConnectionInfo } from '../interfaces/kafka-connection';
import { KafkaQueryService } from '../services/kafka-query.service';
import {
  KafkaAssistResult,
  KafkaAssistService,
} from '../services/kafka-assist.service';
import { KafkaAssistDto, KafkaRunDto } from '../dto/kafka-console.dto';

/**
 * Kafka console: a kafka-shell command runner + an NL copilot. Topics/cluster
 * info feed the visualization; `run` executes one command (writes gated by the
 * read-only flag); `assist` turns a prompt into a kafka-shell command.
 */
@UseGuards(PlatformFoundationGuard, AppOwnershipGuard)
@Controller('applications/:id/kafka')
export class KafkaConsoleController {
  constructor(
    private readonly kafka: KafkaQueryService,
    private readonly assistant: KafkaAssistService,
  ) {}

  @Get('connection-info')
  connectionInfo(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<KafkaConnectionInfo> {
    return this.kafka.connectionInfo({
      appId: id,
      fluiUserId: req.user.userId,
    });
  }

  @Get('cluster-info')
  clusterInfo(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<ClusterInfo> {
    return this.kafka.clusterInfo({ appId: id, fluiUserId: req.user.userId });
  }

  @Get('topics')
  topics(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<TopicSummary[]> {
    return this.kafka.topics({ appId: id, fluiUserId: req.user.userId });
  }

  @Get('groups')
  groups(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<GroupSummary[]> {
    return this.kafka.groups({ appId: id, fluiUserId: req.user.userId });
  }

  @Post('run')
  run(
    @Param('id') id: string,
    @Body() dto: KafkaRunDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<CommandResult> {
    return this.kafka.runCommand(
      { appId: id, fluiUserId: req.user.userId },
      dto.command,
      { readOnly: dto.readOnly !== false },
    );
  }

  @Post('assist')
  assist(
    @Param('id') id: string,
    @Body() dto: KafkaAssistDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<KafkaAssistResult> {
    return this.assistant.assist(
      { appId: id, fluiUserId: req.user.userId },
      dto.prompt,
      dto.conversation ?? [],
      {
        model: dto.model,
        provider: dto.provider,
        connectionId: dto.connectionId,
      },
    );
  }
}
