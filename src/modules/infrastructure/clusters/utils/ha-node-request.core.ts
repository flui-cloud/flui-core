import { ClusterHaState } from '../../../cluster-ha/utils/cluster-ha.core';
import { HaNodeRole } from './ha-node-role';

/**
 * Whether the cluster still needs this role in this location, as its high
 * availability view says. Only what is missing is added: a fourth server, or
 * a second one in a location, would change the votes the control plane counts
 * without making the cluster survive anything more.
 */
export function haNodeRefusal(
  clusterName: string,
  state: ClusterHaState,
  role: HaNodeRole,
  zone: string,
): string | null {
  if (state.unsupported) return state.unsupported;
  const zones = state.topology?.zones ?? [];
  const where = zones.find((z) => z.zone === zone);
  if (!where) {
    return `${zone} is not one of ${clusterName}'s locations for high availability (${zones.map((z) => z.zone).join(', ')}).`;
  }
  if (role === 'data-host' && where.role !== 'data') {
    return `${zone} only votes: copies of data live in ${zones
      .filter((z) => z.role === 'data')
      .map((z) => z.zone)
      .join(' and ')}.`;
  }
  if (state.missing.some((m) => m.role === role && m.zone === zone)) {
    return null;
  }
  if (role === 'server') {
    return `${zone} already has a server (${where.servers.join(', ')}). A lost server is replaced once it has been removed from the cluster.`;
  }
  return `${zone} already has a node for data (${where.dataHosts.join(', ')}).`;
}
