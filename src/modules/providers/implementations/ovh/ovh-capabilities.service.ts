import { Injectable, Logger } from '@nestjs/common';
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

  constructor(private readonly configService: ConfigService) {}

  getAvailableRegions(): Promise<ProviderRegion[]> {
    return this.inner.getAvailableRegions();
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
      return result.success
        ? { success: true, message: 'Credentials are valid' }
        : { success: false, message: result.error ?? 'Invalid credentials' };
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
      vnetTopology: null,
      vnetRequired: false,
      crossClusterAllowed: false,
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
