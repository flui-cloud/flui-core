import { BadRequestException } from '@nestjs/common';
import { ClusterEntity } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { CloudProvider } from '../../enums/cloud-provider.enum';

export interface HostTarget {
  host: string;
  port: number;
  user: string;
}

/**
 * Where Flui reaches a cluster's nodes over SSH.
 *
 * BYOS is the awkward case and the reason this is not a one-liner: the operator
 * declares the reachable host, port and user, per cluster and optionally per
 * node, and `node.ipAddress` is only a fallback — falling back to :22 on a host
 * that declares another port locks Flui out of it.
 */
export function deriveHostTargets(cluster: ClusterEntity): HostTarget[] {
  return cluster.provider === CloudProvider.BYOS
    ? deriveByosTargets(cluster)
    : deriveProvisionedTargets(cluster);
}

function deriveProvisionedTargets(cluster: ClusterEntity): HostTarget[] {
  const targets = collectNodeHosts(cluster).map((host) => ({
    host,
    port: 22,
    user: 'root',
  }));
  if (targets.length === 0) {
    throw new BadRequestException(
      `No reachable SSH endpoint for cluster ${cluster.id}`,
    );
  }
  return targets;
}

function deriveByosTargets(cluster: ClusterEntity): HostTarget[] {
  const byos = (cluster.metadata as { byos?: Partial<HostTarget> } | undefined)
    ?.byos;
  const clusterPort = byos?.port ?? 22;
  const clusterUser = byos?.user ?? 'root';
  const seen = new Set<string>();
  const targets: HostTarget[] = [];
  for (const node of cluster.nodes ?? []) {
    const nb = (node.metadata as { byos?: Partial<HostTarget> } | undefined)
      ?.byos;
    const host = nb?.host || node.ipAddress || byos?.host;
    if (!host) continue;
    const target = {
      host,
      port: nb?.port ?? clusterPort,
      user: nb?.user ?? clusterUser,
    };
    const key = `${target.host}:${target.port}:${target.user}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(target);
    }
  }
  if (targets.length > 0) return targets;
  const host = byos?.host || cluster.masterIpAddress;
  if (host) return [{ host, port: clusterPort, user: clusterUser }];
  throw new BadRequestException(
    `No reachable SSH endpoint for cluster ${cluster.id}`,
  );
}

function collectNodeHosts(cluster: ClusterEntity): string[] {
  const ips = new Set<string>();
  for (const node of cluster.nodes ?? []) {
    if (node.ipAddress) ips.add(node.ipAddress);
  }
  if (cluster.masterIpAddress) ips.add(cluster.masterIpAddress);
  return [...ips];
}
