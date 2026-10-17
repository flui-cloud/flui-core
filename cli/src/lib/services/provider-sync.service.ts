import { ApiClient } from '../api-client';
import { ConfigStorage } from '../config-storage';
import { getScalewayRegions } from '../../config/defaults';

/**
 * Provider sync service - Synchronizes CLI provider configuration to API
 */

// Enums matching API
export enum CloudProvider {
  HETZNER = 'hetzner',
  SCALEWAY = 'scaleway',
}

export enum CredentialType {
  API_KEY = 'api_key',
  ACCESS_KEY_SECRET = 'access_key_secret',
  USER_PASSWORD = 'user_password',
  BEARER_TOKEN = 'bearer_token',
}

// DTOs matching API
export interface ProviderCredentialsDto {
  provider: CloudProvider;
  type: CredentialType;
  apiKey?: string;
  accessKey?: string;
  secretKey?: string;
  username?: string;
  password?: string;
  clientId?: string;
  clientSecret?: string;
  bearerToken?: string;
}

export interface ConfigureProviderDto {
  provider: CloudProvider;
  credentials: ProviderCredentialsDto;
  enabledRegions: string[];
  additionalConfig?: Record<string, any>;
}

export interface ProviderConfiguration {
  id: string;
  provider: CloudProvider;
  status: string;
  enabledRegions: string[];
  configuration: Record<string, any>;
  isActive: boolean;
  lastHealthCheck?: Date;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProviderSyncResult {
  success: boolean;
  message: string;
  providerConfiguration?: ProviderConfiguration;
  error?: string;
}

// Provider-specific region configurations
const PROVIDER_REGIONS: Record<CloudProvider, string[]> = {
  [CloudProvider.HETZNER]: ['nbg1', 'fsn1', 'hel1', 'ash', 'hil'],
  [CloudProvider.SCALEWAY]: getScalewayRegions(),
};

export class ProviderSyncService {
  private readonly configStorage: ConfigStorage;
  private apiClient: ApiClient;

  constructor(apiUrl: string) {
    this.configStorage = new ConfigStorage();
    this.apiClient = new ApiClient({
      baseUrl: apiUrl,
      apiKey: this.configStorage.getApiKey(),
    });
  }

  setApiKey(apiKey: string): void {
    this.apiClient = new ApiClient({
      baseUrl: this.apiClient.getBaseUrl(),
      apiKey,
    });
  }

  /**
   * Check if provider exists in API
   */
  async checkProviderExists(provider: CloudProvider): Promise<boolean> {
    try {
      await this.apiClient.get(`/management/configurations/${provider}`);
      return true;
    } catch (error: any) {
      if (error.statusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Get provider configuration from API
   */
  async getProviderConfiguration(
    provider: CloudProvider,
  ): Promise<ProviderConfiguration | null> {
    try {
      const config = await this.apiClient.get<ProviderConfiguration>(
        `/management/configurations/${provider}`,
      );
      return config;
    } catch (error: any) {
      if (error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Validate provider is supported
   */
  private validateProvider(provider: string): CloudProvider {
    const normalizedProvider = provider.toLowerCase();
    if (
      !Object.values(CloudProvider).includes(
        normalizedProvider as CloudProvider,
      )
    ) {
      throw new Error(
        `Unsupported provider: ${provider}. Supported providers: ${Object.values(CloudProvider).join(', ')}`,
      );
    }
    return normalizedProvider as CloudProvider;
  }

  /**
   * Get credential type for provider
   */
  private getCredentialType(provider: CloudProvider): CredentialType {
    if (provider === CloudProvider.SCALEWAY) {
      return CredentialType.ACCESS_KEY_SECRET;
    }
    return CredentialType.API_KEY;
  }

  /**
   * Get regions to enable for provider
   */
  private getRegionsToEnable(
    provider: CloudProvider,
    specifiedRegions?: string[],
  ): string[] {
    if (specifiedRegions && specifiedRegions.length > 0) {
      return specifiedRegions;
    }

    // Return all available regions for provider
    return PROVIDER_REGIONS[provider] || [];
  }

  /**
   * Build ConfigureProviderDto from CLI config
   */
  private async buildConfigureDto(
    provider: CloudProvider,
    regions?: string[],
  ): Promise<ConfigureProviderDto> {
    const credentialType = this.getCredentialType(provider);
    const enabledRegions = this.getRegionsToEnable(provider, regions);

    const credentials: ProviderCredentialsDto = {
      provider,
      type: credentialType,
    };

    if (credentialType === CredentialType.ACCESS_KEY_SECRET) {
      const stored = this.configStorage.getCredentials(provider) as {
        accessKey?: string;
        secretKey?: string;
      } | null;
      if (!stored?.accessKey || !stored?.secretKey) {
        throw new Error(
          `No credentials found for ${provider}. Configure them with: flui config set ${provider}`,
        );
      }
      credentials.accessKey = stored.accessKey;
      credentials.secretKey = stored.secretKey;
    } else {
      const apiToken = this.configStorage.getToken(provider);
      if (!apiToken) {
        throw new Error(
          `No API token found for ${provider}. Please configure it first using: flui config set ${provider} <token>`,
        );
      }
      if (credentialType === CredentialType.API_KEY) {
        credentials.apiKey = apiToken;
      } else if (credentialType === CredentialType.BEARER_TOKEN) {
        credentials.bearerToken = apiToken;
      }
    }

    return {
      provider,
      credentials,
      enabledRegions,
      additionalConfig: {},
    };
  }

  /**
   * Sync provider from CLI to API
   */
  async syncProvider(
    providerName: string,
    options: {
      regions?: string[];
      force?: boolean;
    } = {},
  ): Promise<ProviderSyncResult> {
    try {
      // Validate provider
      const provider = this.validateProvider(providerName);

      // Check if provider already exists
      const existingConfig = await this.getProviderConfiguration(provider);

      if (existingConfig && !options.force) {
        return {
          success: false,
          message: `Provider ${provider} is already configured in the API. Use --force to overwrite.`,
          providerConfiguration: existingConfig,
        };
      }

      // Build configuration DTO
      const configDto = await this.buildConfigureDto(provider, options.regions);

      // Configure provider in API
      const response = await this.apiClient.post<ProviderConfiguration>(
        `/management/providers/${provider}/configure`,
        configDto,
      );

      return {
        success: true,
        message: `Successfully synced ${provider} provider to API`,
        providerConfiguration: response,
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to sync provider: ${error.message}`,
        error: error.details || error.message,
      };
    }
  }

  /**
   * Get API client base URL
   */
  getApiUrl(): string {
    return this.apiClient.getBaseUrl();
  }
}
