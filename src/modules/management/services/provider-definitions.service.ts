import { Injectable, Logger } from '@nestjs/common';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { CapabilitiesProviderFactory } from '../../providers/core/factories/capabilities-provider.factory';
import { ProviderCapabilities } from '../entities/provider-capabilities.entity';
import { ProviderDefinition } from '../entities/provider-definition.entity';

@Injectable()
export class ProviderDefinitionsService {
  private readonly logger = new Logger(ProviderDefinitionsService.name);

  constructor(
    private readonly capabilitiesFactory: CapabilitiesProviderFactory,
  ) {}

  async getAllProviders(): Promise<ProviderDefinition[]> {
    const supportedProviders = this.capabilitiesFactory.getSupportedProviders();

    const providerDefinitions = await Promise.all(
      supportedProviders.map(async (provider) => {
        return this.getProvider(provider);
      }),
    );

    return providerDefinitions.filter(Boolean).filter((p) => p.enabled);
  }

  async getProvider(
    provider: CloudProvider,
  ): Promise<ProviderDefinition | undefined> {
    if (!this.capabilitiesFactory.isProviderSupported(provider)) {
      return undefined;
    }

    try {
      const capabilitiesService =
        this.capabilitiesFactory.getCapabilitiesService(provider);

      const providerInfo = await capabilitiesService.getProviderInfo();
      const capabilities = capabilitiesService.getStaticCapabilities();

      return {
        id: provider,
        name: providerInfo.name,
        displayName: providerInfo.displayName,
        description: providerInfo.description,
        logoUrl: providerInfo.logoUrl,
        websiteUrl: providerInfo.websiteUrl,
        documentationUrl: providerInfo.documentationUrl,
        accessKeyDocumentationUrl: providerInfo.accessKeyDocumentationUrl,
        supportUrl: providerInfo.supportUrl,
        pricingUrl: providerInfo.pricingUrl,
        enabled: this.isProviderEnabled(provider),
        capabilities,
        credentialFields: providerInfo.credentialFields,
        dnsZoneDelegation: providerInfo.dnsZoneDelegation,
      } as ProviderDefinition;
    } catch (error) {
      this.logger.error(`Error loading provider ${provider}:`, error);
      return undefined;
    }
  }

  async getProviderCapabilities(
    provider: CloudProvider,
  ): Promise<ProviderCapabilities | undefined> {
    if (!this.capabilitiesFactory.isProviderSupported(provider)) {
      return undefined;
    }

    try {
      const capabilitiesService =
        this.capabilitiesFactory.getCapabilitiesService(provider);
      return await capabilitiesService.getCapabilities();
    } catch (error) {
      this.logger.error(`Error loading capabilities for ${provider}:`, error);
      return undefined;
    }
  }

  async getProviderRegions(provider: CloudProvider) {
    if (!this.capabilitiesFactory.isProviderSupported(provider)) {
      return [];
    }

    try {
      const capabilitiesService =
        this.capabilitiesFactory.getCapabilitiesService(provider);
      return await capabilitiesService.getAvailableRegions();
    } catch (error) {
      this.logger.error(`Error loading regions for ${provider}:`, error);
      return [];
    }
  }

  async getProviderInstanceTypes(provider: CloudProvider) {
    if (!this.capabilitiesFactory.isProviderSupported(provider)) {
      return [];
    }

    try {
      const capabilitiesService =
        this.capabilitiesFactory.getCapabilitiesService(provider);
      return await capabilitiesService.getSupportedInstanceTypes();
    } catch (error) {
      this.logger.error(`Error loading instance types for ${provider}:`, error);
      return [];
    }
  }

  getProviderLogo(provider: CloudProvider): {
    data: Buffer;
    contentType: string;
  } {
    if (!this.capabilitiesFactory.isProviderSupported(provider)) {
      throw new Error(`Provider ${provider} not found`);
    }
    const svc = this.capabilitiesFactory.getCapabilitiesService(provider);
    return { data: svc.getLogo(), contentType: svc.getLogoContentType() };
  }

  getSupportedProviders(): CloudProvider[] {
    return this.capabilitiesFactory.getSupportedProviders();
  }

  isProviderSupported(provider: CloudProvider): boolean {
    return this.capabilitiesFactory.isProviderSupported(provider);
  }

  /**
   * Check if a provider is enabled and available for use
   * Hetzner: enabled
   * Contabo: disabled (under development)
   */
  private isProviderEnabled(provider: CloudProvider): boolean {
    switch (provider) {
      case CloudProvider.HETZNER:
        return true;

      case CloudProvider.CONTABO:
        return false;

      case CloudProvider.SCALEWAY:
        return true;

      case CloudProvider.OVH:
        return true;

      default:
        return false;
    }
  }
}
