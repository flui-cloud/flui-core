/**
 * Local mirror of provider credential schemas.
 *
 * This duplicates the contract that the API exposes via
 * `IProviderCapabilitiesService.getProviderInfo().credentialFields` because the
 * CLI runs *before* a Flui API exists (chicken-and-egg during environment
 * bootstrap) and the management endpoints require auth. When the API gains a
 * public schema endpoint, replace this file's source with a fetch and keep the
 * shape stable.
 *
 * Keep in sync with:
 *   src/modules/providers/implementations/<provider>/<provider>-capabilities.service.ts
 */
export type CliCredentialType = 'api_key' | 'access_key_secret';

export type CliSupportedProvider = 'hetzner' | 'scaleway' | 'ovh';

export interface CliCredentialField {
  key: string;
  label: string;
  hint?: string;
  secret: boolean;
  required: boolean;
}

export interface CliProviderCredentialSchema {
  provider: CliSupportedProvider;
  type: CliCredentialType;
  fields: CliCredentialField[];
}

export const PROVIDER_CREDENTIAL_SCHEMAS: Record<
  CliSupportedProvider,
  CliProviderCredentialSchema
> = {
  hetzner: {
    provider: 'hetzner',
    type: 'api_key',
    fields: [
      {
        key: 'apiKey',
        label: 'Hetzner API Token',
        hint: 'Hetzner Cloud Console → Security → API Tokens',
        secret: true,
        required: true,
      },
    ],
  },
  scaleway: {
    provider: 'scaleway',
    type: 'access_key_secret',
    fields: [
      {
        key: 'accessKey',
        label: 'Access Key ID',
        hint: 'Scaleway Console → IAM → API Keys → Access Key ID',
        secret: false,
        required: true,
      },
      {
        key: 'secretKey',
        label: 'Secret Key',
        hint: 'Scaleway Console → IAM → API Keys → Secret Key (shown once at creation)',
        secret: true,
        required: true,
      },
    ],
  },
  ovh: {
    provider: 'ovh',
    type: 'access_key_secret',
    fields: [
      {
        key: 'accessKey',
        label: 'OpenStack Username',
        hint: 'OVH Manager → Public Cloud → Users & Roles',
        secret: false,
        required: true,
      },
      {
        key: 'secretKey',
        label: 'OpenStack Password',
        hint: 'Set when the OpenStack user was created',
        secret: true,
        required: true,
      },
    ],
  },
};

export function getCredentialSchema(
  provider: string,
): CliProviderCredentialSchema | null {
  const key = provider.toLowerCase() as CliSupportedProvider;
  return PROVIDER_CREDENTIAL_SCHEMAS[key] ?? null;
}

export function isCompoundProvider(provider: string): boolean {
  const schema = getCredentialSchema(provider);
  return schema?.type === 'access_key_secret';
}
