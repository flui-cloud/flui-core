import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IProviderCapabilitiesService,
  InstanceTypeInfo,
  ProviderInfo,
} from '../../interfaces/provider-capabilities.interface';
import { ProviderRegion } from '../../../management/entities/provider-region.entity';
import { CloudProvider } from '../../enums/cloud-provider.enum';
import { ProviderCapabilities } from '../../../management/entities/provider-capabilities.entity';
import {
  ProviderCredentials,
  CredentialType,
} from '../../../management/entities/credentials.entity';
import { ValidationResultDto } from '../../../management/dto/validation-result.dto';
import { getRegionCoordinates } from '../../data/region-coordinates';

@Injectable()
export class ContaboCapabilitiesService
  implements IProviderCapabilitiesService
{
  constructor(private readonly configService: ConfigService) {}

  async getAvailableRegions(): Promise<ProviderRegion[]> {
    const make = (
      id: string,
      name: string,
      displayName: string,
      location: string,
      country: string,
      flagEmoji: string,
    ): ProviderRegion => {
      const coords = getRegionCoordinates(CloudProvider.CONTABO, id);
      return {
        id,
        name,
        displayName,
        location,
        available: true,
        flagEmoji,
        country,
        latitude: coords?.latitude,
        longitude: coords?.longitude,
      };
    };
    return [
      make(
        'EU',
        'Hub Europe',
        'Hub Europe (Lauterbourg, FR/DE)',
        'Lauterbourg, France/Germany border',
        'France/Germany',
        '🇪🇺',
      ),
      make(
        'EU-1',
        'Nuremberg',
        'Nuremberg, Germany',
        'Nuremberg, Germany',
        'Germany',
        '🇩🇪',
      ),
      make(
        'EU-2',
        'Munich',
        'Munich, Germany',
        'Munich, Germany',
        'Germany',
        '🇩🇪',
      ),
      make(
        'UK',
        'Portsmouth',
        'Portsmouth, United Kingdom',
        'Portsmouth, England',
        'United Kingdom',
        '🇬🇧',
      ),
    ];
  }

  async getSupportedInstanceTypes(): Promise<InstanceTypeInfo[]> {
    // Contabo bills monthly only — hourly rate is approximate (monthly / 730)
    return [
      {
        id: 'CLOUD-VPS-10',
        name: 'Cloud VPS 10',
        description: '4 vCPU, 8 GB RAM, 75 GB NVMe',
        cpu: 4,
        memory: 8192,
        disk: 76800,
        bandwidth: 32000,
        pricing: { hourly: 0.0062, monthly: 4.5, currency: 'EUR' },
        available: true,
      },
      {
        id: 'CLOUD-VPS-20',
        name: 'Cloud VPS 20',
        description: '6 vCPU, 12 GB RAM, 100 GB NVMe',
        cpu: 6,
        memory: 12288,
        disk: 102400,
        bandwidth: 32000,
        pricing: { hourly: 0.0096, monthly: 7, currency: 'EUR' },
        available: true,
      },
      {
        id: 'CLOUD-VPS-30',
        name: 'Cloud VPS 30',
        description: '8 vCPU, 24 GB RAM, 200 GB NVMe',
        cpu: 8,
        memory: 24576,
        disk: 204800,
        bandwidth: 32000,
        pricing: { hourly: 0.0192, monthly: 14, currency: 'EUR' },
        available: true,
      },
      {
        id: 'CLOUD-VPS-40',
        name: 'Cloud VPS 40',
        description: '12 vCPU, 48 GB RAM, 250 GB NVMe',
        cpu: 12,
        memory: 49152,
        disk: 256000,
        bandwidth: 32000,
        pricing: { hourly: 0.0342, monthly: 25, currency: 'EUR' },
        available: true,
      },
      {
        id: 'CLOUD-VPS-50',
        name: 'Cloud VPS 50',
        description: '16 vCPU, 64 GB RAM, 300 GB NVMe',
        cpu: 16,
        memory: 65536,
        disk: 307200,
        bandwidth: 32000,
        pricing: { hourly: 0.0507, monthly: 37, currency: 'EUR' },
        available: true,
      },
      {
        id: 'CLOUD-VPS-60',
        name: 'Cloud VPS 60',
        description: '18 vCPU, 96 GB RAM, 350 GB NVMe',
        cpu: 18,
        memory: 98304,
        disk: 358400,
        bandwidth: 32000,
        pricing: { hourly: 0.0671, monthly: 49, currency: 'EUR' },
        available: true,
      },
    ];
  }

  async getProviderInfo(): Promise<ProviderInfo> {
    return {
      id: CloudProvider.CONTABO,
      name: 'contabo',
      displayName: 'Contabo',
      description: 'European VPS provider with competitive monthly pricing',
      logoUrl: '/api/v1/management/providers/contabo/logo',
      websiteUrl: 'https://contabo.com/',
      documentationUrl: 'https://api.contabo.com/',
      supportUrl: 'https://contabo.com/en/support/',
      accessKeyDocumentationUrl:
        'https://api.contabo.com/#section/Introduction/Product-documentation',
      pricingUrl: 'https://contabo.com/en/pricing/',
      credentialFields: {
        type: CredentialType.USER_PASSWORD,
        supportsExpiry: false,
        fields: [
          {
            key: 'clientId',
            label: 'Client ID',
            providerLabel: 'Client ID',
            hint: 'Contabo API → OAuth2 credentials → Client ID',
            secret: false,
            required: true,
          },
          {
            key: 'clientSecret',
            label: 'Client Secret',
            providerLabel: 'Client Secret',
            hint: 'Contabo API → OAuth2 credentials → Client Secret',
            secret: true,
            required: true,
          },
          {
            key: 'username',
            label: 'Username',
            providerLabel: 'Username',
            hint: 'Your Contabo account email address',
            secret: false,
            required: true,
          },
          {
            key: 'password',
            label: 'Password',
            providerLabel: 'Password',
            hint: 'Your Contabo account password',
            secret: true,
            required: true,
          },
        ],
      },
    };
  }

  async validateCredentials(
    credentials: ProviderCredentials,
  ): Promise<ValidationResultDto> {
    return {
      success: false,
      message:
        'Use type: user_password with username, password, clientId and clientSecret',
    };
  }

  private static readonly LOGO_PATH = path.resolve(
    process.cwd(),
    'dist/modules/providers/implementations/contabo/assets/logo.svg',
  );

  getLogo(): Buffer {
    return fs.readFileSync(ContaboCapabilitiesService.LOGO_PATH);
  }

  getLogoContentType(): string {
    return 'image/svg+xml';
  }

  getStaticCapabilities(): ProviderCapabilities {
    return {
      supportedInstanceTypes: [],
      supportedRegions: [],
      credentialType: 'user_password',
      features: {
        autoScaling: false,
        loadBalancers: false,
        privateNetworking: true,
        snapshots: true,
        backups: true,
        dnsZones: false,
        nodeProvisioning: false,
      },
      pricing: {
        currency: 'EUR',
        billingCycle: 'monthly',
        minimumCost: 4.5, // Cloud VPS 10: 4 vCPU, 8 GB RAM @ €4.50/mo
      },
      firewall: {
        backend: 'host-nftables',
        managedEdge: false,
        supportsSshAllowlist: false,
      },
      vnetTopology: null, // Contabo VNet not yet implemented
      vnetRequired: true,
      crossClusterAllowed: false,
    };
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
}
