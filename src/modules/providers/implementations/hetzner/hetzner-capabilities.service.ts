import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IProviderCapabilitiesService,
  InstanceTypeInfo,
  ProviderInfo,
} from '../../interfaces/provider-capabilities.interface';
import {
  ProviderCredentials,
  CredentialType,
} from '../../../management/entities/credentials.entity';
import { ValidationResultDto } from '../../../management/dto/validation-result.dto';
import { ProviderRegion } from '../../../management/entities/provider-region.entity';
import { CloudProvider } from '../../enums/cloud-provider.enum';
import { ProviderCapabilities } from '../../../management/entities/provider-capabilities.entity';
import { ICredentialProvider } from '../../interfaces/credential-provider.interface';
import {
  Configuration,
  LocationsApi,
  ServerTypesApi,
} from 'src/modules/providers/implementations/hetzner/generated';
import { getRegionCoordinates } from '../../data/region-coordinates';

@Injectable()
export class HetznerCapabilitiesService
  implements IProviderCapabilitiesService
{
  private readonly logger = new Logger(HetznerCapabilitiesService.name);
  private readonly basePath: string;

  constructor(
    private readonly configService: ConfigService,
    @Inject('ICredentialProvider')
    private readonly credentialProvider: ICredentialProvider,
  ) {
    this.basePath = this.configService.get<string>(
      'HETZNER_API_BASE_PATH',
      'https://api.hetzner.cloud/v1',
    );
  }

  async getAvailableRegions(): Promise<ProviderRegion[]> {
    this.logger.log('Fetching available regions from Hetzner API');

    try {
      const token = await this.credentialProvider.getActiveApiToken(
        CloudProvider.HETZNER,
      );

      const configuration = new Configuration({
        accessToken: token,
        basePath: this.basePath,
      });

      const locationsApi = new LocationsApi(configuration);
      const response = await locationsApi.listLocations();

      this.logger.log(
        `Fetched ${response.data.locations.length} locations from Hetzner`,
      );

      return this.mapHetznerLocationsToRegions(response.data.locations);
    } catch (error) {
      this.logger.error(
        `Failed to fetch regions from Hetzner API: ${error?.response?.data?.error?.message ?? error?.message ?? 'unknown error'}`,
      );
      this.logger.warn('Using fallback mock data for regions');
      return this.getMockRegions();
    }
  }

  async getSupportedInstanceTypes(): Promise<InstanceTypeInfo[]> {
    this.logger.log('Fetching supported instance types from Hetzner API');

    try {
      const token = await this.credentialProvider.getActiveApiToken(
        CloudProvider.HETZNER,
      );

      const configuration = new Configuration({
        accessToken: token,
        basePath: this.basePath,
      });

      const serverTypesApi = new ServerTypesApi(configuration);
      const response = await serverTypesApi.listServerTypes();

      this.logger.log(
        `Fetched ${response.data.server_types.length} server types from Hetzner`,
      );

      return this.mapHetznerServerTypesToInstanceTypes(
        response.data.server_types,
      );
    } catch (error) {
      this.logger.error(
        'Failed to fetch instance types from Hetzner API',
        error,
      );
      this.logger.warn('Using fallback mock data for instance types');
      return this.getMockInstanceTypes();
    }
  }

  async getProviderInfo(): Promise<ProviderInfo> {
    return {
      id: CloudProvider.HETZNER,
      name: 'hetzner',
      displayName: 'Hetzner Cloud',
      description:
        'German cloud provider with excellent price/performance ratio',
      logoUrl: '/api/v1/management/providers/hetzner/logo',
      websiteUrl: 'https://www.hetzner.com/cloud',
      documentationUrl: 'https://docs.hetzner.cloud/',
      supportUrl: 'https://community.hetzner.com/',
      accessKeyDocumentationUrl:
        'https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/',
      pricingUrl: 'https://www.hetzner.com/cloud#pricing',
      credentialFields: {
        type: CredentialType.API_KEY,
        supportsExpiry: true,
        fields: [
          {
            key: 'apiKey',
            label: 'API Token',
            providerLabel: 'API Token',
            hint: 'Hetzner Cloud Console → Security → API Tokens → Generate API Token',
            secret: true,
            required: true,
          },
        ],
      },
      dnsZoneDelegation: {
        delegationGuideUrl:
          'https://docs.hetzner.com/dns-console/dns/general/delegating-a-domain-to-hetzner-dns/',
      },
    };
  }

  private static readonly LOGO_PATH = path.resolve(
    process.cwd(),
    'dist/modules/providers/implementations/hetzner/assets/logo.svg',
  );

  getLogo(): Buffer {
    return fs.readFileSync(HetznerCapabilitiesService.LOGO_PATH);
  }

  getLogoContentType(): string {
    return 'image/svg+xml';
  }

  async validateCredentials(
    credentials: ProviderCredentials,
  ): Promise<ValidationResultDto> {
    if (credentials.type !== CredentialType.API_KEY || !credentials.apiKey) {
      return {
        success: false,
        message: 'An API token is required for Hetzner',
      };
    }

    try {
      const configuration = new Configuration({
        accessToken: credentials.apiKey,
        basePath: this.basePath,
      });
      const locationsApi = new LocationsApi(configuration);
      await locationsApi.listLocations();
      return { success: true, message: 'API token is valid' };
    } catch (error) {
      if (error.response?.status === 401) {
        return { success: false, message: 'Invalid API token' };
      }
      this.logger.error('Hetzner credential validation failed', error.message);
      return { success: false, message: 'Validation failed: ' + error.message };
    }
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    const [regions, instanceTypes] = await Promise.all([
      this.getAvailableRegions(),
      this.getSupportedInstanceTypes(),
    ]);

    return {
      ...this.getStaticCapabilities(),
      supportedInstanceTypes: instanceTypes.map((type) => type.id),
      supportedRegions: regions,
    };
  }

  getStaticCapabilities(): ProviderCapabilities {
    return {
      supportedInstanceTypes: [],
      supportedRegions: [],
      credentialType: 'api_key',
      features: {
        autoScaling: false,
        loadBalancers: true,
        privateNetworking: true,
        snapshots: true,
        backups: true,
        dnsZones: true,
        nodeProvisioning: true,
      },
      pricing: {
        currency: 'EUR',
        billingCycle: 'hourly',
        minimumCost: 0.0056, // CX23: 2 vCPU, 4 GB RAM @ €2.99/mo
      },
      // Hetzner private networks are ZONE-SCOPED: a single VNet is tied to exactly one
      // network zone. Servers within the same zone (e.g. fsn1/nbg1/hel1 all share
      // eu-central) can join the same VNet. Cross-zone communication is not possible
      // over private networks. Subnets within a VNet are further scoped by zone.
      // Only eu-central is in scope for Flui — us-east/us-west/ap-southeast excluded.
      // Ref: https://docs.hetzner.com/networking/networks/faq/
      vnetTopology: {
        scope: 'regional',
        zones: [
          {
            id: 'eu-central',
            displayName: 'Europe (Central)',
            coveredRegions: ['fsn1', 'nbg1', 'hel1'],
          },
        ],
        supportsSubnets: true,
        subnetPerZone: true,
        supportsRoutes: true,
        // Networks are isolated (no shared VPC): different networks may reuse
        // the same range with no conflict, so no cross-VNet overlap to avoid.
        sharedAddressSpace: false,
        // Hetzner accepts /8–/29 for both VNet and subnets
        // Ref: https://docs.hetzner.com/cloud/networks/overview/
        vnetIpRange: { minPrefix: 8, maxPrefix: 29 },
        subnetIpRange: { minPrefix: 8, maxPrefix: 29 },
      },
      firewall: {
        backend: 'managed-api',
        managedEdge: true,
        supportsSshAllowlist: true,
      },
      vnetRequired: true,
      crossClusterAllowed: false,
    };
  }

  private mapHetznerLocationsToRegions(locations: any[]): ProviderRegion[] {
    return locations
      .filter((location) => this.isEuropeanLocation(location))
      .map((location) => {
        const coords = getRegionCoordinates(
          CloudProvider.HETZNER,
          location.name,
        );
        return {
          id: location.name,
          name: location.city,
          displayName: location.city,
          location: location.country,
          available: true,
          flagEmoji: this.getCountryFlag(location.country),
          country: location.country,
          latitude: coords?.latitude,
          longitude: coords?.longitude,
        };
      });
  }

  private isEuropeanLocation(location: any): boolean {
    if (location.network_zone === 'eu-central') {
      return true;
    }

    const europeanCountries = [
      'DE',
      'FI',
      'NL',
      'AT',
      'BE',
      'FR',
      'IT',
      'ES',
      'PL',
      'CZ',
      'SE',
      'NO',
      'DK',
      'CH',
      'GB',
      'IE',
      'PT',
    ];

    return europeanCountries.includes(location.country);
  }

  private mapHetznerServerTypesToInstanceTypes(
    serverTypes: any[],
  ): InstanceTypeInfo[] {
    return serverTypes
      .filter((type) => !type.deprecated)
      .map((type) => {
        const defaultPrice =
          type.prices && type.prices.length > 0 ? type.prices[0] : null;

        return {
          id: type.name,
          name: type.name.toUpperCase(),
          description: type.description,
          cpu: type.cores,
          memory: type.memory * 1024,
          disk: type.disk * 1024,
          bandwidth: 20000,
          pricing: {
            hourly: defaultPrice
              ? Number.parseFloat(defaultPrice.price_hourly?.net || '0')
              : 0,
            monthly: defaultPrice
              ? Number.parseFloat(defaultPrice.price_monthly?.net || '0')
              : 0,
            currency: 'EUR',
          },
          available: !type.deprecated,
        };
      });
  }

  private getCountryFlag(country: string): string {
    const flags: Record<string, string> = {
      Germany: '🇩🇪',
      Finland: '🇫🇮',
      USA: '🇺🇸',
      'United States': '🇺🇸',
      Netherlands: '🇳🇱',
      Singapore: '🇸🇬',
    };
    return flags[country] || '🌐';
  }

  private getMockRegions(): ProviderRegion[] {
    const make = (
      id: string,
      name: string,
      country: string,
      flagEmoji: string,
    ): ProviderRegion => {
      const coords = getRegionCoordinates(CloudProvider.HETZNER, id);
      return {
        id,
        name,
        displayName: `${name}, ${country}`,
        location: country,
        available: true,
        flagEmoji,
        country,
        latitude: coords?.latitude,
        longitude: coords?.longitude,
      };
    };
    return [
      make('fsn1', 'Falkenstein', 'Germany', '🇩🇪'),
      make('nbg1', 'Nuremberg', 'Germany', '🇩🇪'),
      make('hel1', 'Helsinki', 'Finland', '🇫🇮'),
    ];
  }

  private getMockInstanceTypes(): InstanceTypeInfo[] {
    // Instances with ≥ 4 GB RAM suitable for observability workloads
    return [
      {
        id: 'cx23',
        name: 'CX23',
        description: '2 vCPU (shared Intel/AMD), 4 GB RAM, 40 GB NVMe',
        cpu: 2,
        memory: 4096,
        disk: 40960,
        bandwidth: 20000,
        pricing: { hourly: 0.0056, monthly: 2.99, currency: 'EUR' },
        available: true,
      },
      {
        id: 'cx33',
        name: 'CX33',
        description: '4 vCPU (shared Intel/AMD), 8 GB RAM, 80 GB NVMe',
        cpu: 4,
        memory: 8192,
        disk: 81920,
        bandwidth: 20000,
        pricing: { hourly: 0.0099, monthly: 5.99, currency: 'EUR' },
        available: true,
      },
      {
        id: 'cx43',
        name: 'CX43',
        description: '8 vCPU (shared Intel/AMD), 16 GB RAM, 160 GB NVMe',
        cpu: 8,
        memory: 16384,
        disk: 163840,
        bandwidth: 20000,
        pricing: { hourly: 0.0193, monthly: 11.99, currency: 'EUR' },
        available: true,
      },
      {
        id: 'cax11',
        name: 'CAX11',
        description: '2 vCPU (ARM Ampere), 4 GB RAM, 40 GB NVMe',
        cpu: 2,
        memory: 4096,
        disk: 40960,
        bandwidth: 20000,
        pricing: { hourly: 0.0061, monthly: 3.29, currency: 'EUR' },
        available: true,
      },
      {
        id: 'cax21',
        name: 'CAX21',
        description: '4 vCPU (ARM Ampere), 8 GB RAM, 80 GB NVMe',
        cpu: 4,
        memory: 8192,
        disk: 81920,
        bandwidth: 20000,
        pricing: { hourly: 0.0112, monthly: 6.49, currency: 'EUR' },
        available: true,
      },
    ];
  }
}
