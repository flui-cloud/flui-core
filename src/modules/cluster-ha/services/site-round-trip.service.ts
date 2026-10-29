import { Injectable } from '@nestjs/common';
import {
  KubernetesService,
  NODE_PROBE_IMAGE,
} from '../../infrastructure/shared/services/kubernetes.service';
import { ThreeLocationCluster } from './cluster-ha.service';
import { clusterHaNodesFrom } from '../utils/cluster-ha.core';
import {
  SiteRoundTrip,
  SiteServer,
  parsePingOutput,
  pingScript,
  roundTripPlan,
} from '../utils/site-round-trip.core';

/**
 * How long a message takes between the cluster's locations, measured from
 * the servers themselves on the addresses their database and copies use: the
 * floor under every write that waits for another location.
 */
@Injectable()
export class SiteRoundTripService {
  constructor(private readonly kubernetes: KubernetesService) {}

  async measure(ha: ThreeLocationCluster): Promise<SiteRoundTrip[]> {
    const ready = new Set(
      clusterHaNodesFrom(ha.nodes)
        .filter((n) => n.server && n.ready)
        .map((n) => n.name),
    );
    const servers: SiteServer[] = ha.nodes
      .filter((n) => ready.has(n.metadata?.name ?? ''))
      .map((n) => ({
        node: n.metadata!.name!,
        zone: n.metadata?.labels?.['topology.kubernetes.io/zone'] ?? '',
        address:
          n.status?.addresses?.find((a) => a.type === 'InternalIP')?.address ??
          '',
      }))
      .filter((s) => s.zone && s.address);
    const trips: SiteRoundTrip[] = [];
    for (const { from, to } of roundTripPlan(servers)) {
      const output = await this.kubernetes.runImageOnNode(
        ha.kubeconfig,
        from.node,
        {
          image: NODE_PROBE_IMAGE,
          command: ['sh', '-c', pingScript(to.map((t) => t.address))],
          hostNetwork: true,
        },
      );
      const averages = parsePingOutput(output);
      for (const t of to) {
        trips.push({
          from: from.zone,
          to: t.zone,
          ms: averages.get(t.address) ?? null,
        });
      }
    }
    return trips;
  }
}
