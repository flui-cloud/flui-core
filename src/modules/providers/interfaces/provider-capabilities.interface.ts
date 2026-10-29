import { ProviderCapabilities } from '../../management/entities/provider-capabilities.entity';
import { ProviderRegion } from '../../management/entities/provider-region.entity';
import { ProviderCredentials } from '../../management/entities/credentials.entity';
import { ValidationResultDto } from '../../management/dto/validation-result.dto';
import { NodeTopology } from '../core/node-topology';

export interface IProviderCapabilitiesService {
  getAvailableRegions(): Promise<ProviderRegion[]>;
  getSupportedInstanceTypes(): Promise<InstanceTypeInfo[]>;
  getProviderInfo(): Promise<ProviderInfo>;
  /**
   * Returns full capabilities including regions and instance types fetched from the provider API.
   * Requires valid credentials. Use for /regions and /instance-types endpoints.
   */
  getCapabilities(): Promise<ProviderCapabilities>;
  /**
   * Returns static capabilities (feature flags, pricing metadata) without any API calls.
   * Safe to call without credentials. Use for listing all available providers.
   */
  getStaticCapabilities(): ProviderCapabilities;
  /**
   * The zone and region a server placed at this location sits in. Null when
   * the provider has no declared answer, so nothing guesses a failure domain.
   */
  nodeTopology(location: string | null | undefined): NodeTopology | null;
  getLogo(): Buffer;
  getLogoContentType(): string;
  /**
   * Validates raw credentials against the provider API before storing them.
   * Each provider implements its own validation logic.
   */
  validateCredentials(
    credentials: ProviderCredentials,
  ): Promise<ValidationResultDto>;
}

export interface InstanceTypeInfo {
  id: string;
  name: string;
  description: string;
  cpu: number;
  memory: number;
  disk: number;
  bandwidth: number;
  pricing: {
    hourly: number;
    monthly: number;
    currency: string;
  };
  available: boolean;
}

export interface CredentialFieldDefinition {
  /** Internal key used by Flui in the request body (e.g. 'apiKey', 'secretKey') */
  key:
    | 'apiKey'
    | 'accessKey'
    | 'secretKey'
    | 'username'
    | 'password'
    | 'clientId'
    | 'clientSecret'
    | 'bearerToken';
  /** Label shown in the Flui UI */
  label: string;
  /** Exact name the provider uses for this field (for UI consistency with provider docs) */
  providerLabel: string;
  /** Where to find this value in the provider console */
  hint: string;
  /** Whether the value should be masked in the UI */
  secret: boolean;
  /** Whether the field is required */
  required: boolean;
}

export interface ProviderCredentialFields {
  type: import('../../management/entities/credentials.entity').CredentialType;
  fields: CredentialFieldDefinition[];
  /**
   * Whether the provider supports setting an expiry on keys.
   * When true, Flui shows an optional "expires at" date picker.
   * The expiry cannot be inferred from the key — it must be entered by the user.
   */
  supportsExpiry: boolean;
}

export interface DnsZoneDelegation {
  /** Official guide URL explaining how to delegate/import an external domain */
  delegationGuideUrl: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  displayName: string;
  description: string;
  logoUrl: string;
  websiteUrl: string;
  documentationUrl: string;
  accessKeyDocumentationUrl?: string;
  pricingUrl?: string;
  supportUrl?: string;
  /** Describes the credential fields required to configure this provider */
  credentialFields: ProviderCredentialFields;
  /** DNS delegation info (only present when provider supports DNS zones) */
  dnsZoneDelegation?: DnsZoneDelegation;
}
