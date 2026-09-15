import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OvhCapabilitiesService as InfraOvhCapabilitiesService } from '@flui-cloud/infra';
import {
  IProviderCapabilitiesService,
  InstanceTypeInfo,
  ProviderInfo,
} from '../../interfaces/provider-capabilities.interface';
import { ProviderRegion } from '../../../management/entities/provider-region.entity';
import { ProviderCapabilities } from '../../../management/entities/provider-capabilities.entity';
import {
  ProviderCredentials,
  CredentialType,
} from '../../../management/entities/credentials.entity';
import { ValidationResultDto } from '../../../management/dto/validation-result.dto';
import { buildOvhOpenStackClient } from './ovh-openstack-client.factory';
import { ovhRegionCode, ovhRegionMeta } from './ovh-region-metadata';
import { ICredentialProvider } from '../../interfaces/credential-provider.interface';
import { CloudProvider } from '../../enums/cloud-provider.enum';

/**
 * Flui-native OVH capabilities — delegates catalog/regions/pricing to
 * @flui-cloud/infra's OvhCapabilitiesService (credential-free, public data),
 * but overrides the credential-facing bits: Flui stores OVH's OpenStack
 * username/password as an access-key-pair credential (encrypted, like every
 * other provider) rather than the app-credential shape @flui-cloud/infra
 * declares, and actually validates it against Keystone instead of always
 * reporting "not implemented".
 */
@Injectable()
export class OvhCapabilitiesService implements IProviderCapabilitiesService {
  private readonly logger = new Logger(OvhCapabilitiesService.name);
  private readonly inner = new InfraOvhCapabilitiesService(this.configService);

  constructor(
    private readonly configService: ConfigService,
    @Inject('ICredentialProvider')
    private readonly credentialProvider: ICredentialProvider,
  ) {}

  /**
   * The regions this credential can actually reach, read from the Keystone
   * service catalog. Region availability is per-project on OVH, so no static
   * list can be right for every account.
   *
   * Falls back to the static list when there is no credential to authenticate
   * with, because the dashboard asks for regions before one is stored.
   */
  async getAvailableRegions(): Promise<ProviderRegion[]> {
    try {
      const client = await this.buildClient();
      if (!client) return this.inner.getAvailableRegions();
      const regions = await this.regionsFromKeystone(client);
      return regions.length ? regions : this.inner.getAvailableRegions();
    } catch (error) {
      this.logger.warn(
        `Could not read OVH regions from Keystone, falling back to the static list: ${String(error)}`,
      );
      return this.inner.getAvailableRegions();
    }
  }

  private async regionsFromKeystone(
    client: Awaited<ReturnType<typeof buildOvhOpenStackClient>>,
  ): Promise<ProviderRegion[]> {
    const keystoneRegions = await client.regions('compute');
    const codes = [...new Set(keystoneRegions.map(ovhRegionCode))].sort(
      (a, b) => a.localeCompare(b),
    );
    return codes.map((code) => {
      const meta = ovhRegionMeta(code);
      const label = meta ? `${meta.city}, ${meta.country}` : code;
      return {
        id: code,
        name: meta?.city ?? code,
        displayName: label,
        location: label,
        available: true,
        country: meta?.country,
        latitude: meta?.latitude,
        longitude: meta?.longitude,
      };
    });
  }

  /** Null when no OVH credential is stored yet — the caller falls back. */
  private async buildClient(): Promise<
    Awaited<ReturnType<typeof buildOvhOpenStackClient>> | undefined
  > {
    const pair = await this.credentialProvider
      .getActiveAccessKeyPair(CloudProvider.OVH)
      .catch(() => undefined);
    if (!pair?.accessKey || !pair.secretKey) return undefined;
    return buildOvhOpenStackClient(
      this.configService,
      pair.accessKey,
      pair.secretKey,
    );
  }

  getSupportedInstanceTypes(): Promise<InstanceTypeInfo[]> {
    return this.inner.getSupportedInstanceTypes();
  }

  async getProviderInfo(): Promise<ProviderInfo> {
    const info = await this.inner.getProviderInfo();
    return {
      ...info,
      credentialFields: {
        type: CredentialType.ACCESS_KEY_SECRET,
        supportsExpiry: false,
        fields: [
          {
            key: 'accessKey',
            label: 'OpenStack Username',
            providerLabel: 'OS_USERNAME',
            hint: 'OVH Manager → Public Cloud → Users & Roles',
            secret: false,
            required: true,
          },
          {
            key: 'secretKey',
            label: 'OpenStack Password',
            providerLabel: 'OS_PASSWORD',
            hint: 'Set when the OpenStack user was created',
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
    if (
      credentials.type !== CredentialType.ACCESS_KEY_SECRET ||
      !credentials.accessKey ||
      !credentials.secretKey
    ) {
      return {
        success: false,
        message: 'An OpenStack username and password are required for OVH',
      };
    }
    try {
      const client = await buildOvhOpenStackClient(
        this.configService,
        credentials.accessKey,
        credentials.secretKey,
      );
      const result = await client.testConnection();
      if (!result.success) {
        return {
          success: false,
          message: result.error ?? 'Invalid credentials',
        };
      }
      // The configuration wizard picks regions before this credential is
      // stored, so the discovery has to travel back with the validation that
      // just authenticated — otherwise the only list it can show is the static
      // one, which on a real account offers regions the credential cannot
      // reach and hides ones it can.
      const regions = await this.regionsFromKeystone(client).catch((error) => {
        this.logger.warn(
          `Validated the OVH credential but could not read its regions: ${String(error)}`,
        );
        return [];
      });
      return {
        success: true,
        message: 'Credentials are valid',
        details: { apiAccess: true, regionsDiscovered: regions.length },
        availableRegions: regions,
      };
    } catch (error) {
      this.logger.warn(`OVH credential validation failed: ${String(error)}`);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Validation failed',
      };
    }
  }

  getLogo(): Buffer {
    return this.inner.getLogo();
  }

  getLogoContentType(): string {
    return this.inner.getLogoContentType();
  }

  getStaticCapabilities(): ProviderCapabilities {
    return {
      supportedInstanceTypes: [],
      supportedRegions: [],
      credentialType: 'access_key_secret',
      features: {
        loadBalancers: false,
        privateNetworking: true,
        // No provider-native VM/image snapshot support (Nova/Glance not wired).
        snapshots: false,
        // Flui's own backup mechanism (PVC copy-pod via Kubernetes Jobs) is
        // provider-independent — works on any K3s cluster, OVH included.
        backups: true,
        dnsZones: false,
        nodeProvisioning: true,
      },
      pricing: {
        currency: 'EUR',
        billingCycle: 'hourly',
        // d2-2: 1 vCPU, 2 GB RAM @ €0.0104/hr (cheapest catalog flavor).
        // Hourly, not monthly — the dashboard multiplies by ~730h to estimate
        // a monthly figure, same convention as Hetzner/Scaleway below.
        minimumCost: 0.0104,
      },
      firewall: {
        // Neutron security groups exist but ship with quota 0 on OVH, so in
        // practice they're unusable — route through the same host-nftables
        // backend BYOS uses instead of the (broken) managed API.
        backend: 'host-nftables',
        managedEdge: false,
        supportsSshAllowlist: false,
      },
      vnetTopology: {
        // A Neutron network is regional: `createVNet` steers the client to the
        // subnet's own zone, and a server in another region cannot join it.
        scope: 'regional',
        // Left to the dynamic call: the regions a credential can reach come
        // from its Keystone catalogue, so a static list here would go stale.
        zones: [],
        supportsSubnets: true,
        subnetPerZone: true,
        // Neutron routers exist, but Flui drives none of them here — and
        // `createVNet` deliberately clears the subnet gateway so a node never
        // picks up a second default route.
        supportsRoutes: false,
        sharedAddressSpace: false,
        // Neutron does not constrain the prefix the way a managed product does.
        vnetIpRange: { minPrefix: 8, maxPrefix: 30 },
        subnetIpRange: { minPrefix: 8, maxPrefix: 30 },
      },
      vnetRequired: false,
      crossClusterAllowed: false,
      // OVH has a private network of its own, so Flui does not build one — with
      // the same caveat as every regional provider: an estate spread across two
      // regions still shares nothing, and that case is what the management
      // overlay is for.
      supportsFluiManagedVNet: false,
      // OVH's node sizes come from the public pricing catalog, which has no
      // live stock signal — a second getNodeSizes(true) call returns the
      // same static data as the first. management.service.ts skips it.
      hasLiveAvailability: false,
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
}
