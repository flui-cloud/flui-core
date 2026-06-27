import { Injectable, NotImplementedException } from '@nestjs/common';
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

@Injectable()
export class ByosCapabilitiesService implements IProviderCapabilitiesService {
  async getAvailableRegions(): Promise<ProviderRegion[]> {
    return [];
  }

  async getSupportedInstanceTypes(): Promise<InstanceTypeInfo[]> {
    return [];
  }

  async getProviderInfo(): Promise<ProviderInfo> {
    return {
      id: CloudProvider.BYOS,
      name: 'byos',
      displayName: 'Bring Your Own Server',
      description:
        'Install Flui on a Linux server you already own, over SSH — no cloud provisioning API.',
      logoUrl: '/api/v1/management/providers/byos/logo',
      websiteUrl: 'https://flui.cloud/',
      documentationUrl: 'https://flui.cloud/docs/byos',
      credentialFields: {
        type: CredentialType.USER_PASSWORD,
        supportsExpiry: false,
        fields: [],
      },
    };
  }

  async validateCredentials(
    _credentials: ProviderCredentials,
  ): Promise<ValidationResultDto> {
    return {
      success: false,
      message:
        'BYOS is configured via `flui env create --host` over SSH, not the credential store.',
    };
  }

  getLogo(): Buffer {
    throw new NotImplementedException('BYOS has no provider logo');
  }

  getLogoContentType(): string {
    return 'image/svg+xml';
  }

  getStaticCapabilities(): ProviderCapabilities {
    return {
      supportedInstanceTypes: [],
      supportedRegions: [],
      credentialType: 'ssh',
      features: {
        autoScaling: false, // dedicated manual-workload flow later
        loadBalancers: false, // k3s ServiceLB / Traefik
        privateNetworking: true, // but manual (operator-wired), see vnetTopology
        snapshots: false, // no provider volume snapshots
        backups: true, // generic S3 export
        dnsZones: false, // nip.io / manual record unless a DNS provider is attached
        nodeProvisioning: false, // no API to create servers
      },
      pricing: {
        currency: 'EUR',
        billingCycle: 'monthly',
        minimumCost: 0, // the operator pays for their own server
      },
      firewall: {
        backend: 'host-nftables',
        managedEdge: false,
        supportsSshAllowlist: false,
      },
      vnetTopology: {
        scope: 'manual',
        zones: [],
        supportsSubnets: false,
        subnetPerZone: false,
        supportsRoutes: false,
        vnetIpRange: { minPrefix: 8, maxPrefix: 30 },
        subnetIpRange: { minPrefix: 8, maxPrefix: 30 },
      },
      vnetRequired: true,
      crossClusterAllowed: true,
    };
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return this.getStaticCapabilities();
  }
}
