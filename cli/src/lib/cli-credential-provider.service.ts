import { Injectable, NotFoundException } from '@nestjs/common';
import { ICredentialProvider } from 'src/modules/providers/interfaces/credential-provider.interface';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { BearerTokenDto } from 'src/modules/access/dto/bearer-token.dto';
import { ConfigStorage } from './config-storage';

/**
 * CLI-specific credential provider that uses file-based ConfigStorage
 * instead of TypeORM repositories.
 *
 * This allows the CLI to work without a database connection while
 * maintaining compatibility with the existing provider architecture.
 */
@Injectable()
export class CliCredentialProviderService implements ICredentialProvider {
  private readonly configStorage: ConfigStorage;

  constructor() {
    this.configStorage = new ConfigStorage();
  }

  /**
   * Get active API token for a cloud provider from CLI config file
   */
  async getActiveApiToken(provider: CloudProvider): Promise<string> {
    const providerName = this.mapProviderEnumToString(provider);

    // Scaleway authenticates HTTP calls with the Secret Key (sent as
    // X-Auth-Token). Most code paths in the provider services treat this as
    // a single "API token" string, so return the secretKey here while keeping
    // the access/secret pair available via getActiveAccessKeyPair().
    if (provider === CloudProvider.SCALEWAY) {
      const creds = this.configStorage.getCredentials(providerName) as {
        secretKey?: string;
      } | null;
      if (!creds?.secretKey) {
        throw new NotFoundException(
          `No credentials configured for ${providerName}. ` +
            `Run: flui config set ${providerName}`,
        );
      }
      return creds.secretKey;
    }

    const token = this.configStorage.getToken(providerName);

    if (!token) {
      throw new NotFoundException(
        `No API token configured for ${providerName}. ` +
          `Run: flui config set ${providerName} YOUR_TOKEN`,
      );
    }

    return token;
  }

  /**
   * Get the access/secret key pair for providers that authenticate with two values
   * (e.g. Scaleway IAM API keys).
   */
  async getActiveAccessKeyPair(
    provider: CloudProvider,
  ): Promise<{ accessKey: string; secretKey: string }> {
    const providerName = this.mapProviderEnumToString(provider);
    const creds = this.configStorage.getCredentials(providerName) as {
      accessKey?: string;
      secretKey?: string;
    } | null;

    if (!creds?.accessKey || !creds?.secretKey) {
      throw new NotFoundException(
        `No credentials configured for ${providerName}. ` +
          `Run: flui config set ${providerName}`,
      );
    }

    return { accessKey: creds.accessKey, secretKey: creds.secretKey };
  }

  async getActiveBearerToken(provider: CloudProvider): Promise<BearerTokenDto> {
    throw new Error(
      'Bearer token authentication is not supported in CLI. ' +
        'Please use API token authentication instead.',
    );
  }

  /**
   * Map CloudProvider enum to lowercase string for config storage
   */
  private mapProviderEnumToString(provider: CloudProvider): string {
    switch (provider) {
      case CloudProvider.HETZNER:
        return 'hetzner';
      case CloudProvider.SCALEWAY:
        return 'scaleway';
      case CloudProvider.OVH:
        return 'ovh';
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }
}
