import { Injectable, NotFoundException } from '@nestjs/common';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { CapabilitiesProviderFactory } from '../../providers/core/factories/capabilities-provider.factory';
import { AccessService } from '../../access/services/access.service';
import { CredentialPurpose } from '../../access/enums/credential-purpose.enum';
import { KeyStorageService } from '../../access/services/key-storage.service';
import {
  InferenceCapability,
  InferenceEndpoint,
} from '../../providers/interfaces/inference-capability';
import { InferenceConnectionRepository } from '../repositories/inference-connection.repository';

/**
 * Unified resolver: collapses a native inference-capable provider OR a BYO connection
 * into a single OpenAI-compatible { baseUrl, apiKey }. This is the surface consumed
 * by the assistant.
 */
@Injectable()
export class InferenceResolverService {
  constructor(
    private readonly capabilities: CapabilitiesProviderFactory,
    private readonly accessService: AccessService,
    private readonly keyStorage: KeyStorageService,
    private readonly connections: InferenceConnectionRepository,
  ) {}

  getInferenceCapability(provider: CloudProvider): InferenceCapability {
    const inference = this.capabilities
      .getCapabilitiesService(provider)
      .getStaticCapabilities().inference;
    if (!inference) {
      throw new NotFoundException(
        `Provider ${provider} has no inference capability`,
      );
    }
    return inference;
  }

  async resolveNative(provider: CloudProvider): Promise<InferenceEndpoint> {
    const inference = this.getInferenceCapability(provider);
    const apiKey = await this.resolveNativeKey(provider, inference);
    return { baseUrl: inference.baseUrl, apiKey };
  }

  async hasNativeCredential(provider: CloudProvider): Promise<boolean> {
    try {
      await this.resolveNative(provider);
      return true;
    } catch {
      return false;
    }
  }

  async resolveConnection(id: string): Promise<InferenceEndpoint> {
    const connection = await this.connections.findById(id);
    if (!connection) {
      throw new NotFoundException(`Inference connection ${id} not found`);
    }
    return {
      baseUrl: connection.base_url,
      apiKey: this.keyStorage.decryptKeyFromString(
        connection.encrypted_api_key,
      ),
    };
  }

  // Shared-credential providers (Scaleway) reuse the COMPUTE secret key as the
  // inference bearer; inference-only providers use a dedicated INFERENCE key.
  private async resolveNativeKey(
    provider: CloudProvider,
    inference: InferenceCapability,
  ): Promise<string> {
    if (inference.sharesComputeCredentials) {
      const pair = await this.accessService.getActiveAccessKeyPair(
        provider,
        CredentialPurpose.COMPUTE,
      );
      return pair.secretKey;
    }
    return this.accessService.getActiveApiToken(
      provider,
      CredentialPurpose.INFERENCE,
    );
  }
}
