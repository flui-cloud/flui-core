import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';

export interface SshTarget {
  host: string;
  port: number;
  user: string;
}

/**
 * Resolve how to SSH to a cluster's master node. BYOS keeps the real endpoint in
 * metadata.byos (the stored master IP may be loopback or behind a published port);
 * provisioned providers use <ip>:22 as root.
 */
export function resolveClusterSshTarget(
  cluster: { provider?: string; metadata?: unknown } | null | undefined,
  fallbackIp: string,
): SshTarget {
  const byos = (cluster?.metadata as { byos?: SshTarget } | undefined)?.byos;
  if (cluster?.provider === CloudProvider.BYOS && byos?.host) {
    return {
      host: byos.host,
      port: byos.port ?? 22,
      user: byos.user ?? 'root',
    };
  }
  return { host: fallbackIp, port: 22, user: 'root' };
}
