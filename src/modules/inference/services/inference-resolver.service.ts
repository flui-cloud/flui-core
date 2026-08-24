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
 * The only thing the spend path needs to know about who is asking: the user id.
 *
 * Deliberately not the whole `AuthenticatedUser` and deliberately not a policy
 * lookup. Spending is decided by ownership alone — NULL row, or her own — so
 * this stays a pure comparison on a hot path that runs on every chat turn and
 * every console question, instead of a second database read per request.
 */
export interface InferencePrincipal {
  userId: string;
}

/**
 * NULL is the installation's and anyone may spend it — the common case today,
 * and the one that must not become harder. Anything else belongs to exactly one
 * person.
 *
 * `iam:manage-users` is deliberately absent here: it buys *visibility* of a
 * colleague's connection (decision 104), and seeing a row is not a licence to
 * charge somebody else's model account. Widening this later is one clause;
 * narrowing it later is a key that has already been spent.
 */
function canSpend(
  connection: { owner_user_id: string | null },
  principal: InferencePrincipal,
): boolean {
  if (connection.owner_user_id === null) return true;
  return !!principal.userId && connection.owner_user_id === principal.userId;
}

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

  inferenceCapableProviders(): CloudProvider[] {
    return this.capabilities
      .getSupportedProviders()
      .filter(
        (p) =>
          !!this.capabilities.getCapabilitiesService(p).getStaticCapabilities()
            .inference,
      );
  }

  async resolveNative(provider: CloudProvider): Promise<InferenceEndpoint> {
    const inference = this.getInferenceCapability(provider);
    const apiKey = await this.resolveNativeKey(provider, inference);
    return {
      baseUrl: inference.baseUrl,
      apiKey,
      defaultModel: inference.defaultModel,
    };
  }

  async hasNativeCredential(provider: CloudProvider): Promise<boolean> {
    try {
      await this.resolveNative(provider);
      return true;
    } catch {
      return false;
    }
  }

  // Default surface for the assistant: prefer a configured native provider
  // (EU-first by capability order), else a BYO connection — the one flagged
  // default, or any configured one when none is flagged (a single connection is
  // implicitly the default; otherwise resolution would 404 despite a usable endpoint).
  async resolveDefault(
    principal: InferencePrincipal,
  ): Promise<InferenceEndpoint> {
    for (const provider of this.inferenceCapableProviders()) {
      if (await this.hasNativeCredential(provider)) {
        return this.resolveNative(provider);
      }
    }
    const fallback =
      (await this.connections.findDefaultUsableBy(principal.userId)) ??
      (await this.connections.findUsableBy(principal.userId))[0];
    if (fallback) {
      return this.resolveConnection(fallback.id, principal);
    }
    throw new NotFoundException('No inference endpoint configured');
  }

  /**
   * The neck. Every path that turns a connection id into a usable key comes
   * through here — the assistant's chat and agent turns, the five console
   * assistants, and the connection validation — so this is the one place that
   * can ask whose row it is and be sure nothing walked around it.
   *
   * The principal is required rather than optional on purpose: an optional
   * argument reopens the hole silently the first time somebody forgets it,
   * while a required one refuses to compile.
   *
   * A row this principal may not spend is answered as *absent*, not forbidden
   * — the shape decisions 4 and 96 already use here. "Forbidden" would confirm
   * that a connection with that id exists, which is half of what the person
   * guessing the uuid wanted to learn.
   */
  async resolveConnection(
    id: string,
    principal: InferencePrincipal,
  ): Promise<InferenceEndpoint> {
    const connection = await this.connections.findById(id);
    if (!connection || !canSpend(connection, principal)) {
      throw new NotFoundException(`Inference connection ${id} not found`);
    }
    return {
      baseUrl: connection.base_url,
      apiKey: this.keyStorage.decryptKeyFromString(
        connection.encrypted_api_key,
      ),
      defaultModel: connection.models?.[0],
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
