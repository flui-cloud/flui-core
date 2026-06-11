import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { InferenceResolverService } from '../../inference/services/inference-resolver.service';
import { InferenceClientService } from '../../inference/services/inference-client.service';
import { InferenceEndpoint } from '../../providers/interfaces/inference-capability';
import { pickChatModel } from '../assistant.constants';

export interface InferenceSelection {
  model?: string;
  provider?: CloudProvider;
  connectionId?: string;
}

/** Resolves a request's inference endpoint + model from the same rules for chat and agent. */
@Injectable()
export class AssistantInferenceService {
  constructor(
    private readonly resolver: InferenceResolverService,
    private readonly client: InferenceClientService,
    private readonly config: ConfigService,
  ) {}

  async resolveEndpoint(
    sel: InferenceSelection,
  ): Promise<{ endpoint: InferenceEndpoint; source: string }> {
    if (sel.connectionId) {
      return {
        endpoint: await this.resolver.resolveConnection(sel.connectionId),
        source: `connection:${sel.connectionId}`,
      };
    }
    if (sel.provider) {
      return {
        endpoint: await this.resolver.resolveNative(sel.provider),
        source: `provider:${sel.provider}`,
      };
    }
    return {
      endpoint: await this.resolver.resolveDefault(),
      source: 'default',
    };
  }

  async resolveModel(
    sel: InferenceSelection,
    endpoint: InferenceEndpoint,
  ): Promise<string> {
    if (sel.model) return sel.model;
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
}
