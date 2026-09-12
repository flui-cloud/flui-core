import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ProviderDefinitionsService } from './provider-definitions.service';
import { ConfigurationModeService } from './configuration-mode.service';
import { ProviderConfigurationRepository } from '../repositories/provider-configuration.repository';
import { AccessService } from '../../access/services/access.service';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { ProviderDefinition } from '../entities/provider-definition.entity';
import { ProviderConfigurationDto } from '../dto/provider-configuration.dto';
import { ConfigureProviderDto } from '../dto/configure-provider.dto';
import { ProviderFiltersDto } from '../dto/provider-filters.dto';
import { ValidationResultDto } from '../dto/validation-result.dto';
import { HealthStatusDto } from '../dto/health-status.dto';
import { ProviderStatus } from '../entities/provider-status.enum';
import { ProviderConfigurationEntity } from '../entities/provider-configuration.entity';
import { ProviderCredentialsDto } from '../dto/credentials.dto';
import { CredentialType } from '../entities/credentials.entity';
import { CreateBearerTokenDto } from 'src/modules/access/dto/create-bearer-token.dto';
import { ProviderFactory } from 'src/modules/providers/services/provider.factory';
import { ICloudProvider } from 'src/modules/providers/interfaces/cloud-provider.interface';
import { CapabilitiesProviderFactory } from 'src/modules/providers/core/factories/capabilities-provider.factory';
import { NodeSizeOptionDto } from '../dto/node-size-option.dto';
import { PricingQueryDto } from '../dto/pricing-query.dto';
import { PricingResponseDto } from '../dto/pricing-response.dto';
import { CacheService } from 'src/modules/common/cache/cache.service';
import { CacheCategory } from 'src/modules/common/cache/enums/cache-category.enum';

@Injectable()
export class ManagementService {
  private readonly logger = new Logger(ManagementService.name);

  constructor(
    private readonly providerDefinitions: ProviderDefinitionsService,
    private readonly configurationMode: ConfigurationModeService,
    private readonly providerConfigRepo: ProviderConfigurationRepository,
    private readonly accessService: AccessService,
    private readonly providerFactory: ProviderFactory,
    private readonly capabilitiesFactory: CapabilitiesProviderFactory,
    private readonly cacheService: CacheService,
  ) {}

  async getAvailableProviders(): Promise<ProviderDefinition[]> {
    return this.providerDefinitions.getAllProviders();
  }

  async getProvider(provider: CloudProvider): Promise<ProviderDefinition> {
    const providerDef = await this.providerDefinitions.getProvider(provider);
    if (!providerDef) {
      throw new NotFoundException(`Provider ${provider} not found`);
    }
    return providerDef;
  }

  getProviderLogo(provider: CloudProvider): {
    data: Buffer;
    contentType: string;
  } {
    return this.providerDefinitions.getProviderLogo(provider);
  }

  async getUserProviderConfigurations(
    filters?: ProviderFiltersDto,
  ): Promise<ProviderConfigurationDto[]> {
    let configurations: ProviderConfigurationEntity[];

    if (filters?.provider) {
      const config = await this.providerConfigRepo.findByProvider(
        filters.provider,
      );
      configurations = config ? [config] : [];
    } else if (filters?.status) {
      configurations = await this.providerConfigRepo.findByStatus(
        filters.status,
      );
    } else if (filters?.isActive !== undefined) {
      if (filters.isActive) {
        configurations = await this.providerConfigRepo.findActiveProviders();
      } else {
        const allConfigs = await this.providerConfigRepo.findAll();
        configurations = allConfigs.filter((config) => !config.isActive);
      }
    } else {
      configurations = await this.providerConfigRepo.findAll();
    }

    return this.enrichConfigurationsWithProviderData(configurations);
  }

  async getProviderConfiguration(
    provider: CloudProvider,
  ): Promise<ProviderConfigurationDto> {
    const config = await this.providerConfigRepo.findByProvider(provider);
    if (!config) {
      throw new NotFoundException(
        `Configuration for provider ${provider} not found`,
      );
    }

    const enriched = await this.enrichConfigurationsWithProviderData([config]);
    return enriched[0];
  }

  async configureProvider(
    configDto: ConfigureProviderDto,
  ): Promise<ProviderConfigurationDto> {
    if (this.configurationMode.isHostedMode()) {
      throw new BadRequestException(
        'Provider configuration not available in hosted mode',
      );
    }

    await this.getProvider(configDto.provider);

    const existingConfig = await this.providerConfigRepo.findByProvider(
      configDto.provider,
    );

    if (existingConfig) {
      throw new BadRequestException(
        `Provider ${configDto.provider} is already configured`,
      );
    }

    const newConfig = await this.providerConfigRepo.create({
      provider: configDto.provider,
      status: ProviderStatus.CONFIGURING,
      enabledRegions: configDto.enabledRegions,
      configuration: configDto.additionalConfig || {},
      isActive: false,
      metadata: {},
    });

    try {
      await this.storeProviderCredentials(configDto);

      await this.providerConfigRepo.update(newConfig.id, {
        status: ProviderStatus.VALIDATING,
      });

      const validationResult = await this.validateProviderCredentials(
        configDto.provider,
        configDto.credentials,
      );

      if (validationResult.success) {
        await this.providerConfigRepo.update(newConfig.id, {
          status: ProviderStatus.ACTIVE,
          isActive: true,
          lastHealthCheck: new Date(),
          metadata: {
            lastValidation: new Date(),
            regionsDiscovered: validationResult.availableRegions?.length || 0,
          },
        });
      } else {
        await this.providerConfigRepo.update(newConfig.id, {
          status: ProviderStatus.ERROR,
          metadata: {
            errorMessage: validationResult.message,
            lastValidation: new Date(),
          },
        });
      }

      const updatedConfig = await this.providerConfigRepo.findByProvider(
        configDto.provider,
      );

      const enriched = await this.enrichConfigurationsWithProviderData([
        updatedConfig,
      ]);
      return enriched[0];
    } catch (error) {
      await this.providerConfigRepo.update(newConfig.id, {
        status: ProviderStatus.ERROR,
        metadata: {
          errorMessage: error.message,
        },
      });
      throw error;
    }
  }

  async validateProvider(
    provider: CloudProvider,
    credentials: ProviderCredentialsDto,
  ): Promise<ValidationResultDto> {
    const providerDef = await this.providerDefinitions.getProvider(provider);

    if (!providerDef) {
      throw new NotFoundException(`Provider ${provider} not found`);
    }

    return this.validateProviderCredentials(provider, credentials);
  }

  async enableProvider(
    provider: CloudProvider,
    enabled: boolean,
  ): Promise<ProviderConfigurationDto> {
    const config = await this.providerConfigRepo.findByProvider(provider);
    if (!config) {
      throw new NotFoundException(`Provider ${provider} not configured`);
    }

    const updatedConfig = await this.providerConfigRepo.update(config.id, {
      isActive: enabled,
      status: enabled ? ProviderStatus.ACTIVE : ProviderStatus.DISABLED,
    });

    const enriched = await this.enrichConfigurationsWithProviderData([
      updatedConfig,
    ]);
    return enriched[0];
  }

  async getProviderHealth(provider: CloudProvider): Promise<HealthStatusDto> {
    const config = await this.providerConfigRepo.findByProvider(provider);
    if (!config) {
      throw new NotFoundException(`Provider ${provider} not configured`);
    }

    const startTime = Date.now();

    try {
      const providerService = this.providerFactory.getProvider(provider);
      const validation = await providerService.testConnection();
      const responseTime = Date.now() - startTime;

      const healthStatus: HealthStatusDto = {
        providerId: provider,
        status: validation.success ? 'healthy' : 'unhealthy',
        responseTime,
        lastCheck: new Date(),
        errorMessage: validation.success ? undefined : validation.error,
        metrics: {
          apiCallsToday: 0,
          errorRate: validation.success ? 0 : 1,
        },
      };

      await this.providerConfigRepo.updateHealthCheck(config.id, {
        lastHealthCheck: new Date(),
        metadata: {
          ...config.metadata,
          lastHealthStatus: healthStatus.status,
          lastResponseTime: responseTime,
        },
      });

      return healthStatus;
    } catch (error) {
      const responseTime = Date.now() - startTime;

      return {
        providerId: provider,
        status: 'unhealthy',
        responseTime,
        lastCheck: new Date(),
        errorMessage: error.message,
        metrics: {
          apiCallsToday: 0,
          errorRate: 1,
        },
      };
    }
  }

  async getProviderRegions(provider: CloudProvider) {
    return this.providerDefinitions.getProviderRegions(provider);
  }

  async getProviderInstanceTypes(provider: CloudProvider) {
    return this.providerDefinitions.getProviderInstanceTypes(provider);
  }

  async getConfigurationMode() {
    return {
      mode: this.configurationMode.getCurrentMode(),
      capabilities: this.configurationMode.getCapabilities(),
    };
  }

  private async enrichConfigurationsWithProviderData(
    configurations: ProviderConfigurationEntity[],
  ): Promise<ProviderConfigurationDto[]> {
    return Promise.all(
      configurations.map(async (config) => {
        const providerDef = await this.providerDefinitions.getProvider(
          config.provider,
        );

        const credMetadata =
          await this.accessService.getActiveCredentialMetadata(config.provider);

        return {
          id: config.id,
          provider: config.provider,
          status: config.status,
          enabledRegions: config.enabledRegions,
          lastHealthCheck: config.lastHealthCheck,
          isActive: config.isActive,
          availableRegions: providerDef?.capabilities.supportedRegions,
          credentialsType: credMetadata?.credentialType,
          credentialsExpiresAt: credMetadata?.expiresAt ?? null,
          metadata: {
            ...config.metadata,
            apiKeyMasked: await this.getMaskedCredentials(config.provider),
          },
          createdAt: config.createdAt,
          updatedAt: config.updatedAt,
        };
      }),
    );
  }

  async rotateProviderCredentials(
    provider: CloudProvider,
    credentials: ProviderCredentialsDto,
  ): Promise<ProviderConfigurationDto> {
    if (this.configurationMode.isHostedMode()) {
      throw new BadRequestException(
        'Provider configuration not available in hosted mode',
      );
    }

    const config = await this.providerConfigRepo.findByProvider(provider);
    if (!config) {
      throw new NotFoundException(`Provider ${provider} not configured`);
    }

    if (credentials.provider !== provider) {
      throw new BadRequestException(
        'Credentials provider does not match URL provider',
      );
    }

    const validation = await this.validateProviderCredentials(
      provider,
      credentials,
    );
    if (!validation.success) {
      throw new BadRequestException(
        validation.message || 'Credential validation failed',
      );
    }

    await this.accessService.deleteActiveProviderCredentials(provider);
    await this.storeProviderCredentials({
      provider,
      credentials,
      enabledRegions: config.enabledRegions,
    } as ConfigureProviderDto);

    const updated = await this.providerConfigRepo.update(config.id, {
      status: ProviderStatus.ACTIVE,
      isActive: true,
      lastHealthCheck: new Date(),
      metadata: {
        ...config.metadata,
        lastValidation: new Date(),
        errorMessage: undefined,
      },
    });

    const enriched = await this.enrichConfigurationsWithProviderData([updated]);
    return enriched[0];
  }

  async updateProviderCredentialsExpiry(
    provider: CloudProvider,
    expiresAt: Date | null,
  ): Promise<ProviderConfigurationDto> {
    const config = await this.providerConfigRepo.findByProvider(provider);
    if (!config) {
      throw new NotFoundException(`Provider ${provider} not configured`);
    }

    await this.accessService.updateActiveCredentialExpiry(provider, expiresAt);

    const enriched = await this.enrichConfigurationsWithProviderData([config]);
    return enriched[0];
  }

  async updateProviderRegions(
    provider: CloudProvider,
    enabledRegions: string[],
  ): Promise<ProviderConfigurationDto> {
    const config = await this.providerConfigRepo.findByProvider(provider);
    if (!config) {
      throw new NotFoundException(`Provider ${provider} not configured`);
    }

    const providerDef = await this.getProvider(provider);
    const supported = providerDef.capabilities.supportedRegions ?? [];
    if (supported.length > 0) {
      const supportedSet = new Set(supported.map((r) => r.id));
      const invalid = enabledRegions.filter((r) => !supportedSet.has(r));
      if (invalid.length > 0) {
        throw new BadRequestException(
          `Unsupported regions for ${provider}: ${invalid.join(', ')}`,
        );
      }
    }

    const updated = await this.providerConfigRepo.update(config.id, {
      enabledRegions,
    });

    const enriched = await this.enrichConfigurationsWithProviderData([updated]);
    return enriched[0];
  }

  private async storeProviderCredentials(
    configDto: ConfigureProviderDto,
  ): Promise<void> {
    const providerDef = await this.providerDefinitions.getProvider(
      configDto.provider,
    );

    if (!providerDef) {
      throw new BadRequestException(
        `Unsupported provider: ${configDto.provider}`,
      );
    }

    const credType = configDto.credentials.type;

    switch (credType) {
      case CredentialType.API_KEY:
        if (!configDto.credentials.apiKey) {
          throw new BadRequestException(
            'API key is required for this provider',
          );
        }
        await this.accessService.createApiToken({
          provider: configDto.provider,
          token: configDto.credentials.apiKey,
          label: `${providerDef.displayName} API Token`,
          notes: 'Auto-generated during provider configuration',
          expiresAt: configDto.credentials.expiresAt
            ? new Date(configDto.credentials.expiresAt)
            : undefined,
        });
        break;

      case CredentialType.ACCESS_KEY_SECRET:
        if (
          !configDto.credentials.accessKey ||
          !configDto.credentials.secretKey
        ) {
          throw new BadRequestException(
            'Access Key ID and Secret Key are required for this provider',
          );
        }
        await this.accessService.createAccessKeyPair({
          provider: configDto.provider,
          accessKey: configDto.credentials.accessKey,
          secretKey: configDto.credentials.secretKey,
          label: `${providerDef.displayName} API Keys`,
          notes: 'Auto-generated during provider configuration',
          expiresAt: configDto.credentials.expiresAt
            ? new Date(configDto.credentials.expiresAt)
            : undefined,
        });
        break;

      case CredentialType.USER_PASSWORD:
        if (
          !configDto.credentials.username ||
          !configDto.credentials.password ||
          !configDto.credentials.clientId ||
          !configDto.credentials.clientSecret
        ) {
          throw new BadRequestException(
            'Username, password, client ID and client secret are required for this provider',
          );
        }
        await this.accessService.generateBearerToken(configDto.provider, {
          provider: configDto.provider,
          username: configDto.credentials.username,
          password: configDto.credentials.password,
          client_id: configDto.credentials.clientId,
          client_secret: configDto.credentials.clientSecret,
          save_credentials: true,
        });
        break;

      default:
        throw new BadRequestException(
          `Unsupported credential type: ${credType}`,
        );
    }
  }

  private async validateProviderCredentials(
    provider: CloudProvider,
    credentials: ProviderCredentialsDto,
  ): Promise<ValidationResultDto> {
    try {
      // USER_PASSWORD is handled locally (OAuth token exchange, no capabilities service needed)
      if (credentials.type === CredentialType.USER_PASSWORD) {
        if (
          !credentials.username ||
          !credentials.password ||
          !credentials.clientId ||
          !credentials.clientSecret
        ) {
          return {
            success: false,
            message:
              'Username, password, client ID and client secret are required',
          };
        }
        const request: CreateBearerTokenDto = {
          provider,
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          username: credentials.username,
          password: credentials.password,
          save_credentials: false,
        };
        try {
          await this.accessService.generateBearerToken(provider, request);
          return { success: true, message: 'Credentials are valid' };
        } catch {
          return { success: false, message: 'Invalid credentials' };
        }
      }

      // All other types are delegated to the provider's capabilities service
      const capabilitiesService =
        this.capabilitiesFactory.getCapabilitiesService(provider);
      return capabilitiesService.validateCredentials({
        provider,
        type: credentials.type,
        apiKey: credentials.apiKey,
        accessKey: credentials.accessKey,
        secretKey: credentials.secretKey,
        expiresAt: credentials.expiresAt
          ? new Date(credentials.expiresAt)
          : undefined,
        bearerToken: credentials.bearerToken,
      });
    } catch (error) {
      return {
        success: false,
        message: error.message || 'Validation failed',
      };
    }
  }

  private async getMaskedCredentials(
    provider: CloudProvider,
  ): Promise<string | undefined> {
    try {
      const providerDef = await this.providerDefinitions.getProvider(provider);

      if (!providerDef) return undefined;

      switch (providerDef.capabilities.credentialType) {
        case 'api_key': {
          const token = await this.accessService.getActiveApiToken(provider);
          return `***${token.slice(-4)}`;
        }

        case 'access_key_secret': {
          const pair =
            await this.accessService.getActiveAccessKeyPair(provider);
          return `${pair.accessKey.slice(0, 4)}***`;
        }

        case 'user_password': {
          const bearerToken =
            await this.accessService.getActiveBearerToken(provider);
          return `***${bearerToken.access_token.slice(-4)}`;
        }

        default:
          return undefined;
      }
    } catch {
      return undefined;
    }
  }

  async removeProviderConfiguration(configId: string): Promise<void> {
    const config = await this.providerConfigRepo.findById(configId);

    if (!config) {
      throw new NotFoundException('Provider configuration not found');
    }

    await this.providerConfigRepo.delete(configId);
  }

  /**
   * Get available node sizes (server types) for a provider
   * Uses partial caching strategy:
   * - Server type metadata (CPU, RAM, prices, etc.) is cached for 24 hours
   * - Real-time availability is ALWAYS fetched fresh (not cached)
   * Optionally filtered by region to show only available server types in that location
   */
  async getNodeSizes(
    provider: CloudProvider,
    region?: string,
    skipCache?: boolean,
  ): Promise<NodeSizeOptionDto[]> {
    const regionSuffix = region ? ` in region: ${region}` : '';
    this.logger.log(
      `Getting node sizes for provider: ${provider}${regionSuffix}`,
    );

    const cloudProvider = this.providerFactory.getProvider(provider);

    if (!cloudProvider.getNodeSizes) {
      throw new BadRequestException(
        `Node sizes not supported for provider: ${provider}`,
      );
    }

    const cacheKey = this.cacheService.buildKey(
      'provider',
      provider,
      'node-sizes-metadata',
    );

    // Metadata (CPU, RAM, prices) is cached; real-time availability is always fresh
    const metadataNodeSizes = await this.cacheService.wrap(
      cacheKey,
      async () => {
        const nodeSizes = await cloudProvider.getNodeSizes(false);
        return nodeSizes as NodeSizeOptionDto[];
      },
      {
        category: CacheCategory.CONFIGURATION,
        skipCache,
        shouldCache: CacheService.shouldCacheResponse,
      },
    );

    // Some providers (e.g. OVH) have no live stock signal — their
    // availability is a static projection of the same catalog snapshot, so a
    // second getNodeSizes(true) call would just re-fetch identical data.
    const capabilities =
      this.capabilitiesFactory.getCapabilitiesService(provider);
    const hasLiveAvailability =
      capabilities.getStaticCapabilities().hasLiveAvailability;

    const allNodeSizes = hasLiveAvailability
      ? await this.mergeWithLiveAvailability(cloudProvider, metadataNodeSizes)
      : metadataNodeSizes;

    if (!region) {
      return allNodeSizes;
    }

    const filteredNodeSizes = allNodeSizes.filter((nodeSize) => {
      if (!nodeSize.availability || !Array.isArray(nodeSize.availability)) {
        if (!nodeSize.locations || !Array.isArray(nodeSize.locations)) {
          return false;
        }
        const location = nodeSize.locations.find((loc) => loc.name === region);
        if (!location) return false;
        if (!location.deprecation) return true;
        return new Date() < new Date(location.deprecation.unavailable_after);
      }

      const locationAvailability = nodeSize.availability.find(
        (av) => av.location === region,
      );

      if (!locationAvailability) return false;

      if (locationAvailability.deprecated) {
        const location = nodeSize.locations?.find((loc) => loc.name === region);
        if (location?.deprecation) {
          if (new Date() >= new Date(location.deprecation.unavailable_after)) {
            return false;
          }
        }
      }

      return locationAvailability.available;
    });

    this.logger.log(
      `Filtered ${allNodeSizes.length} node sizes to ${filteredNodeSizes.length} available in region ${region}`,
    );

    return filteredNodeSizes;
  }

  /** Enriches cached metadata with a fresh, uncached availability call — only worth it for providers with real live stock (see hasLiveAvailability). */
  private async mergeWithLiveAvailability(
    cloudProvider: ICloudProvider,
    metadataNodeSizes: NodeSizeOptionDto[],
  ): Promise<NodeSizeOptionDto[]> {
    const nodeSizesWithAvailability = await cloudProvider.getNodeSizes!(true);
    return metadataNodeSizes.map((metadata) => {
      const withAvailability = nodeSizesWithAvailability.find(
        (ns) => ns.id === metadata.id,
      );
      return {
        ...metadata,
        availability: withAvailability?.availability || [],
      };
    });
  }

  /**
   * Get pricing information for a provider
   * Cached for 24 hours (CONFIGURATION category)
   */
  async getPricing(
    provider: CloudProvider,
    query: PricingQueryDto,
    skipCache?: boolean,
  ): Promise<PricingResponseDto> {
    this.logger.log(`Getting pricing for provider: ${provider}`, { query });

    const cacheKey = this.cacheService.buildKey(
      'provider',
      provider,
      'pricing',
      query.region || 'all',
      query.nodeSize || 'all',
    );

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const cloudProvider = this.providerFactory.getProvider(provider);

        if (!cloudProvider.getPricing) {
          throw new BadRequestException(
            `Pricing not supported for provider: ${provider}`,
          );
        }

        const pricing = await cloudProvider.getPricing(query);

        // Map from provider DTO to management DTO (they're currently identical)
        return pricing as PricingResponseDto;
      },
      {
        category: CacheCategory.CONFIGURATION,
        skipCache,
        // Use helper to validate response should be cached
        shouldCache: CacheService.shouldCacheResponse,
      },
    );
  }

  /**
   * Clear node sizes cache for a specific provider
   */
  async clearNodeSizesCache(provider: CloudProvider): Promise<void> {
    const cacheKey = this.cacheService.buildKey(
      CacheCategory.CONFIGURATION,
      `provider:${provider}:node-sizes`,
    );
    await this.cacheService.delete(cacheKey);
  }
}
