import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';

/** Maps the CLI's lowercase provider keys to the backend's CloudProvider enum. */
export const CLOUD_PROVIDER_BY_KEY: Record<string, CloudProvider> = {
  hetzner: CloudProvider.HETZNER,
  scaleway: CloudProvider.SCALEWAY,
  ovh: CloudProvider.OVH,
};
