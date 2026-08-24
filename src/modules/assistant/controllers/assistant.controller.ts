import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Request,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Request as ExpressRequest, Response } from 'express';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { describeError } from '../../shared/utils/error.util';
import { AssistantService } from '../services/assistant.service';
import { AssistantAgentService } from '../services/assistant-agent.service';
import { KnowledgeService } from '../services/knowledge.service';
import { AssistantRecommendationsService } from '../services/assistant-recommendations.service';
import { InferenceProviderException } from '../services/inference-error.util';
import { ChatCompletionRequestDto } from '../dto/chat-completion-request.dto';
import { AgentRequestDto } from '../dto/agent-request.dto';
import { AssistantRecommendationsDto } from '../dto/assistant-recommendations.dto';
import { AgentStreamEvent } from '../interfaces/agent-events';
import { credentialFromRequest } from '../../mcp/services/mcp-api.client';
import { actorFromRequest } from '../../auth/utils/actor.util';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@ApiTags('Assistant')
@ApiBearerAuth()
@Controller('assistant/v1')
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly agent: AssistantAgentService,
    private readonly knowledge: KnowledgeService,
    private readonly recommendations: AssistantRecommendationsService,
    private readonly config: ConfigService,
  ) {}

  @Get('info')
  @ApiOperation({
    summary: 'Assistant identity, KB version binding, and server capabilities',
  })
  @ApiResponse({ status: 200 })
  info() {
    return {
      ...this.knowledge.getInfo(),
      capabilities: {
        destructiveEnabled:
          this.config.get<string>('MCP_ALLOW_DESTRUCTIVE') === 'true',
      },
    };
  }

  @Get('recommendations')
  @ApiOperation({
    summary:
      'Recommended inference providers and models for the assistant, plus the overall recommended pick',
  })
  @ApiResponse({ status: 200, type: AssistantRecommendationsDto })
  getRecommendations(): AssistantRecommendationsDto {
    return this.recommendations.getRecommendations();
  }

  @Post('chat/completions')
  @ApiOperation({
    summary:
      'OpenAI-compatible chat completion routed to the configured inference endpoint',
  })
  @ApiResponse({ status: 200 })
  @HttpCode(HttpStatus.OK)
  async chatCompletions(
    @Request() req: AuthenticatedRequest,
    @Body() dto: ChatCompletionRequestDto,
  ) {
    return this.assistant.chat(req.user, dto);
  }

  @Post('agent')
  @ApiOperation({
    summary:
      'Agentic turn: answers from the knowledge base or calls Flui tools, pausing on write/destructive actions for confirmation',
  })
  @ApiResponse({ status: 200 })
  @HttpCode(HttpStatus.OK)
  async agentTurn(
    @Request() req: AuthenticatedRequest,
    @Body() dto: AgentRequestDto,
  ) {
    return this.agent.run(
      req.user,
      dto,
      undefined,
      credentialFromRequest(req),
      actorFromRequest(req),
    );
  }

  @Post('agent/stream')
  @ApiOperation({
    summary:
      'Same agentic turn as /agent, streamed over Server-Sent Events: text deltas, live tool steps, and a terminal "done" frame carrying the canonical AgentResult',
  })
  @ApiResponse({ status: 200, content: { 'text/event-stream': {} } })
  async agentStream(
    @Request() req: AuthenticatedRequest,
    @Body() dto: AgentRequestDto,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Defeat reverse-proxy response buffering so frames flush as they're written.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: AgentStreamEvent) =>
      res.write(`data: ${JSON.stringify(event)}\n\n`);

    try {
      const result = await this.agent.run(
        req.user,
        dto,
        send,
        credentialFromRequest(req),
        actorFromRequest(req),
      );
      send({ type: 'done', result });
    } catch (error) {
      if (error instanceof InferenceProviderException) {
        send({
          type: 'error',
          message: error.message,
          code: error.code,
          retryAfter: error.retryAfter,
        });
      } else {
        send({ type: 'error', message: describeError(error) });
      }
    } finally {
      res.end();
    }
  }
}
