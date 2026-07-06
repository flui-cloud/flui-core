import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  IProviderCapabilitiesService,
  InstanceTypeInfo,
  ProviderInfo,
} from '../../interfaces/provider-capabilities.interface';
import { ProviderRegion } from '../../../management/entities/provider-region.entity';
import { ProviderCapabilities } from '../../../management/entities/provider-capabilities.entity';
import { CloudProvider } from '../../enums/cloud-provider.enum';
import { ICredentialProvider } from '../../interfaces/credential-provider.interface';
import {
  ProviderCredentials,
  CredentialType,
} from '../../../management/entities/credentials.entity';
import { ValidationResultDto } from '../../../management/dto/validation-result.dto';
import {
  Configuration,
  InstanceTypesApi,
  ListServersTypesZoneEnum,
} from 'src/modules/providers/implementations/scaleway/generated/instances';
import {
  SSHKeysApi,
  Configuration as IamConfiguration,
} from 'src/modules/providers/implementations/scaleway/generated/iam';
import { getRegionCoordinates } from '../../data/region-coordinates';
import { SCALEWAY_INFERENCE } from './scaleway-inference';

@Injectable()
export class ScalewayCapabilitiesService
  implements IProviderCapabilitiesService
{
  private readonly logger = new Logger(ScalewayCapabilitiesService.name);

  private readonly baseUrl = 'https://api.scaleway.com';

  constructor(
    @Inject('ICredentialProvider')
    private readonly credentialProvider: ICredentialProvider,
  ) {}

  async getAvailableRegions(): Promise<ProviderRegion[]> {
    return this.getStaticRegions();
  }

  async getSupportedInstanceTypes(): Promise<InstanceTypeInfo[]> {
    this.logger.log('Fetching supported instance types from Scaleway API');

    try {
      const token = await this.credentialProvider.getActiveApiToken(
        CloudProvider.SCALEWAY,
      );

      const api = new InstanceTypesApi(
        new Configuration({
          basePath: this.baseUrl,
          baseOptions: { headers: { 'X-Auth-Token': token } },
        }),
      );

      const response = await api.listServersTypes(
        ListServersTypesZoneEnum.FrPar1,
      );
      const serversTypes = response.data.servers as Record<string, any>;

      return Object.entries(serversTypes ?? {})
        .filter(([, t]) => t.arch === 'x86_64')
        .map(([id, t]) => ({
          id,
          name: id,
          description: t.alt_name ?? id,
          cpu: t.ncpus ?? 0,
          memory: (t.ram ?? 0) / (1024 * 1024),
          disk: 0,
          bandwidth: t.network?.max_bandwidth ?? 0,
          pricing: {
            hourly: t.hourly_price ?? 0,
            monthly:
              typeof t.monthly_price === 'number' && t.monthly_price > 0
                ? t.monthly_price
                : (t.hourly_price ?? 0) * 730,
            currency: 'EUR',
          },
          available: !t.end_of_service,
        }));
    } catch (error) {
      this.logger.error(
        'Failed to fetch instance types from Scaleway API',
        error,
      );
      this.logger.warn('Using fallback mock data for instance types');
      return this.getMockInstanceTypes();
    }
  }

  async getProviderInfo(): Promise<ProviderInfo> {
    return {
      id: CloudProvider.SCALEWAY,
      name: 'scaleway',
      displayName: 'Scaleway',
      description:
        'French cloud provider — Instances (VMs) and Elastic Metal (bare metal)',
      logoUrl: '/api/v1/management/providers/scaleway/logo',
      websiteUrl: 'https://www.scaleway.com',
      documentationUrl: 'https://www.scaleway.com/en/developers/',
      accessKeyDocumentationUrl:
        'https://www.scaleway.com/en/docs/identity-and-access-management/iam/how-to/create-api-keys/',
      pricingUrl: 'https://www.scaleway.com/en/pricing/',
      supportUrl: 'https://console.scaleway.com/support',
      credentialFields: {
        type: CredentialType.ACCESS_KEY_SECRET,
        supportsExpiry: true,
        fields: [
          {
            key: 'accessKey',
            label: 'Access Key ID',
            providerLabel: 'Access Key ID',
            hint: 'Scaleway Console → IAM → API Keys → Access Key ID',
            secret: false,
            required: true,
          },
          {
            key: 'secretKey',
            label: 'Secret Key',
            providerLabel: 'Secret Key',
            hint: 'Scaleway Console → IAM → API Keys → Secret Key (shown once at creation)',
            secret: true,
            required: true,
          },
        ],
      },
      dnsZoneDelegation: {
        delegationGuideUrl:
          'https://www.scaleway.com/en/docs/network/domains-and-dns/how-to/add-external-domain/',
      },
    };
  }

  private static readonly LOGO_PATH = path.resolve(
    process.cwd(),
    'dist/modules/providers/implementations/scaleway/assets/logo.svg',
  );

  getLogo(): Buffer {
    return fs.readFileSync(ScalewayCapabilitiesService.LOGO_PATH);
  }

  getLogoContentType(): string {
    return 'image/svg+xml';
  }

  async validateCredentials(
    credentials: ProviderCredentials,
  ): Promise<ValidationResultDto> {
    if (
      credentials.type !== CredentialType.ACCESS_KEY_SECRET ||
      !credentials.secretKey
    ) {
      return {
        success: false,
        message: 'An Access Key ID and Secret Key are required for Scaleway',
      };
    }

    try {
      // Validate by calling IAM listSSHKeys — lightweight, no side effects
      // BASE_PATH is already 'https://api.scaleway.com'; the client appends '/iam/v1alpha1/ssh-keys'
      const api = new SSHKeysApi(
        new IamConfiguration({
          baseOptions: {
            headers: { 'X-Auth-Token': credentials.secretKey },
          },
        }),
      );
      await api.listSSHKeys();
      return { success: true, message: 'Credentials are valid' };
    } catch (error) {
      if (error.response?.status === 401 || error.response?.status === 403) {
        return { success: false, message: 'Invalid Secret Key' };
      }
      this.logger.error('Scaleway credential validation failed', error.message);
      return {
        success: false,
        message: 'Validation failed: ' + error.message,
      };
    }
  }

  getStaticCapabilities(): ProviderCapabilities {
    return {
      supportedInstanceTypes: [],
      supportedRegions: [],
      credentialType: 'api_key',
      features: {
        autoScaling: true, // Native Instance Scaling Groups with metrics-based policies
        loadBalancers: true,
        privateNetworking: true,
        snapshots: true,
        backups: true, // Block Storage backups + snapshot automation
        dnsZones: true,
        nodeProvisioning: true,
      },
      pricing: {
        currency: 'EUR',
        billingCycle: 'hourly',
        minimumCost: 0.0088, // DEV1-S: 2 vCPU, 2 GB RAM @ €0.0088/hr (practical minimum)
      },
      // Scaleway private networks are REGIONAL: each VNet is confined to a single region.
      // To connect servers across Paris, Amsterdam and Warsaw you need a VNet per region.
      // Subnets are flat within the region (no zone sub-scoping); routing is not supported.
      vnetTopology: {
        scope: 'regional',
        zones: [
          {
            id: 'fr-par',
            displayName: 'Paris (France)',
            coveredRegions: ['fr-par'],
          },
          {
            id: 'nl-ams',
            displayName: 'Amsterdam (Netherlands)',
            coveredRegions: ['nl-ams'],
          },
          {
            id: 'pl-waw',
            displayName: 'Warsaw (Poland)',
            coveredRegions: ['pl-waw'],
          },
        ],
        supportsSubnets: false,
        subnetPerZone: false,
        supportsRoutes: false,
        // Private networks live in a shared VPC per region → ranges across
        // different networks must not overlap (subnet_overlaps_in_vpc).
        sharedAddressSpace: true,
        // Scaleway VPC constraints (official docs: scaleway.com/en/docs/vpc/how-to/create-private-network/)
        // Both the private network and its subnets share the same /20–/28 prefix range.
        // Use 10.x.x.x ranges for consistency with other providers.
        vnetIpRange: { minPrefix: 20, maxPrefix: 28 },
        subnetIpRange: { minPrefix: 20, maxPrefix: 28 },
      },
      firewall: {
        backend: 'managed-api',
        managedEdge: true,
        supportsSshAllowlist: true,
      },
      vnetRequired: true,
      crossClusterAllowed: false,
      inference: SCALEWAY_INFERENCE,
    };
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    const [regions, instanceTypes] = await Promise.all([
      this.getAvailableRegions(),
      this.getSupportedInstanceTypes(),
    ]);

    return {
      ...this.getStaticCapabilities(),
      supportedInstanceTypes: instanceTypes.map((t) => t.id),
      supportedRegions: regions,
    };
  }

  private getStaticRegions(): ProviderRegion[] {
    const make = (
      id: string,
      name: string,
      country: string,
      flagEmoji: string,
    ): ProviderRegion => {
      const coords = getRegionCoordinates(CloudProvider.SCALEWAY, id);
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
      make('fr-par', 'Paris', 'France', '🇫🇷'),
      make('nl-ams', 'Amsterdam', 'Netherlands', '🇳🇱'),
      make('pl-waw', 'Warsaw', 'Poland', '🇵🇱'),
    ];
  }

  private getMockInstanceTypes(): InstanceTypeInfo[] {
    // Instances with ≥ 4 GB RAM suitable for observability workloads
    return [
      {
        id: 'DEV1-M',
        name: 'DEV1-M',
        description: 'Development 1 Medium — 3 vCPU, 4 GB RAM, 40 GB NVMe',
        cpu: 3,
        memory: 4096,
        disk: 40960,
        bandwidth: 200,
        pricing: { hourly: 0.0088, monthly: 6.42, currency: 'EUR' },
        available: true,
      },
      {
        id: 'DEV1-L',
        name: 'DEV1-L',
        description: 'Development 1 Large — 4 vCPU, 8 GB RAM, 80 GB NVMe',
        cpu: 4,
        memory: 8192,
        disk: 81920,
        bandwidth: 400,
        pricing: { hourly: 0.0175, monthly: 12.78, currency: 'EUR' },
        available: true,
      },
      {
        id: 'GP1-XS',
        name: 'GP1-XS',
        description: 'General Purpose XSmall — 4 vCPU, 16 GB RAM, local SSD',
        cpu: 4,
        memory: 16384,
        disk: 0,
        bandwidth: 500,
        pricing: { hourly: 0.0246, monthly: 17.99, currency: 'EUR' },
        available: true,
      },
      {
        id: 'GP1-S',
        name: 'GP1-S',
        description: 'General Purpose Small — 8 vCPU, 32 GB RAM, local SSD',
        cpu: 8,
        memory: 32768,
        disk: 0,
        bandwidth: 800,
        pricing: { hourly: 0.0493, monthly: 35.99, currency: 'EUR' },
        available: true,
      },
    ];
  }
}
