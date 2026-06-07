import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InferenceResolverService } from '../../inference/services/inference-resolver.service';
import { InferenceClientService } from '../../inference/services/inference-client.service';
import { InferenceEndpoint } from '../../providers/interfaces/inference-capability';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ChatCompletionRequestDto } from '../dto/chat-completion-request.dto';
import { ChatCompletionResponse } from '../interfaces/chat-completion';
import {
  DEFAULT_ASSISTANT_TEMPERATURE,
  pickChatModel,
} from '../assistant.constants';
import { AssistantLlmService } from './assistant-llm.service';
import { AssistantGuardService } from './assistant-guard.service';
import { KnowledgeService } from './knowledge.service';
import { AssistantAuditRepository } from '../repositories/assistant-audit.repository';

@Injectable()
export class AssistantService {
  constructor(
    private readonly resolver: InferenceResolverService,
    private readonly client: InferenceClientService,
    private readonly llm: AssistantLlmService,
    private readonly guard: AssistantGuardService,
    private readonly knowledge: KnowledgeService,
    private readonly audit: AssistantAuditRepository,
    private readonly config: ConfigService,
  ) {}

  async chat(
    user: AuthenticatedUser,
    dto: ChatCompletionRequestDto,
  ): Promise<ChatCompletionResponse> {
    const { endpoint, source } = await this.resolveEndpoint(dto);
    const model = await this.resolveModel(dto, endpoint);

    // One cheap call gates off-topic AND selects which knowledge to inject, so the
    // answer prompt stays small instead of the whole 76k-token corpus.
    const route = await this.guard.route(
      endpoint,
      model,
      dto.messages,
      this.knowledge.getIndexPrompt(),
    );
    if (route.offTopic) {
      const content = await this.guard.refusal(endpoint, model, dto.messages);
      await this.record(user, model, `${source}:refused`, dto);
      return this.refusalResponse(model, content);
    }

    const response = await this.llm.chat(endpoint, {
      model,
      messages: [
        {
          role: 'system',
          content: this.knowledge.getSystemContext(route.sectionIds),
        },
        ...dto.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      temperature: dto.temperature ?? DEFAULT_ASSISTANT_TEMPERATURE,
      max_tokens: dto.maxTokens,
      stream: false,
    });

    await this.record(user, model, source, dto);
    return response;
  }

  private async resolveEndpoint(
    dto: ChatCompletionRequestDto,
  ): Promise<{ endpoint: InferenceEndpoint; source: string }> {
    if (dto.connectionId) {
      return {
        endpoint: await this.resolver.resolveConnection(dto.connectionId),
        source: `connection:${dto.connectionId}`,
      };
    }
    if (dto.provider) {
      return {
        endpoint: await this.resolver.resolveNative(dto.provider),
        source: `provider:${dto.provider}`,
      };
    }
    return {
      endpoint: await this.resolver.resolveDefault(),
      source: 'default',
    };
  }

  private async resolveModel(
    dto: ChatCompletionRequestDto,
    endpoint: InferenceEndpoint,
  ): Promise<string> {
    if (dto.model) return dto.model;
    // Model ids are provider-specific, so prefer the source's own default.
    if (endpoint.defaultModel) return endpoint.defaultModel;
    const override = this.config.get<string>('ASSISTANT_DEFAULT_MODEL');
    if (override) return override;
    const models = await this.client.listModelIds(
      endpoint.baseUrl,
      endpoint.apiKey,
    );
    const chat = pickChatModel(models);
    if (!chat) {
      throw new ServiceUnavailableException(
        'No chat model available on the inference endpoint',
      );
    }
    return chat;
  }

  private refusalResponse(
    model: string,
    content: string,
  ): ChatCompletionResponse {
    const created = Math.floor(Date.now() / 1000);
    return {
      id: `flui-refusal-${created}`,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
    };
  }

  private async record(
    user: AuthenticatedUser,
    model: string,
    source: string,
    dto: ChatCompletionRequestDto,
  ): Promise<void> {
    await this.audit.record({
      userId: user.userId,
      model,
      source,
      messageCount: dto.messages.length,
    });
  }
}
