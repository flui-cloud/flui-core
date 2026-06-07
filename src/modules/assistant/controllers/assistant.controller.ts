import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Request,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AssistantService } from '../services/assistant.service';
import { KnowledgeService } from '../services/knowledge.service';
import { ChatCompletionRequestDto } from '../dto/chat-completion-request.dto';

interface AuthenticatedRequest {
  user: AuthenticatedUser;
}

@ApiTags('Assistant')
@ApiBearerAuth()
@Controller('assistant/v1')
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly knowledge: KnowledgeService,
  ) {}

  @Get('info')
  @ApiOperation({
    summary: 'Assistant identity and knowledge-base version binding',
  })
  @ApiResponse({ status: 200 })
  info() {
    return this.knowledge.getInfo();
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
}
