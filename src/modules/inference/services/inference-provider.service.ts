import { Injectable, Logger } from '@nestjs/common';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { ValidationResultDto } from '../../management/dto/validation-result.dto';
import { InferenceClientService } from './inference-client.service';
import { InferenceResolverService } from './inference-resolver.service';
import { InferenceProviderInfoDto } from '../dto/inference-provider-info.dto';

/**
 * Native inference providers expose inference as a capability and reuse the provider's
 * existing credential (no dedicated key). Surfaced inside provider management.
 */
@Injectable()
export class InferenceProviderService {
  private readonly logger = new Logger(InferenceProviderService.name);

  constructor(
    private readonly client: InferenceClientService,
    private readonly resolver: InferenceResolverService,
  ) {}

  async listProviders(): Promise<InferenceProviderInfoDto[]> {
    const providers = this.resolver.inferenceCapableProviders();
    return Promise.all(
      providers.map(async (provider) => {
        const inference = this.resolver.getInferenceCapability(provider);
        const configured = await this.resolver.hasNativeCredential(provider);
        let models: string[] = inference.models.map((m) => m.id);
        if (configured) {
          try {
            const endpoint = await this.resolver.resolveNative(provider);
            models = await this.client.listModelIds(
              endpoint.baseUrl,
              endpoint.apiKey,
            );
          } catch (error) {
            this.logger.warn(
              `Failed to list models for ${provider}: ${error.message}`,
            );
          }
        }
        return {
          provider,
          baseUrl: inference.baseUrl,
          euDataResidency: inference.euDataResidency,
          configured,
          models,
          defaultModel: inference.defaultModel,
        };
      }),
    );
  }

  // Tests the inherited provider credential against the inference endpoint.
  async validate(provider: CloudProvider): Promise<ValidationResultDto> {
    try {
      const endpoint = await this.resolver.resolveNative(provider);
      const models = await this.client.listModelIds(
        endpoint.baseUrl,
        endpoint.apiKey,
      );
      return {
        success: true,
        message: `Valid — ${models.length} models reachable`,
      };
    } catch (error) {
      if (error.response?.status === 401 || error.response?.status === 403) {
        return {
          success: false,
          message: 'Provider credential lacks inference access',
        };
      }
      return { success: false, message: `Validation failed: ${error.message}` };
    }
  }
}
