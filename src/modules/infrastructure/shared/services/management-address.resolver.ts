import { Injectable } from '@nestjs/common';

export type ManagementPath = 'private' | 'public' | 'wireguard';

/**
 * What the caller knows about the management overlay for one cluster.
 *
 * Passed in rather than looked up, so this class stays free of a repository and
 * of the question "is the overlay on" — which belongs to whoever owns the
 * peers, not to whoever picks an address.
 */
export interface OverlayContext {
  controlAddress: string;
  /**
   * Whether this cluster's nodes actually have a live peer. False during
   * enrolment, and the difference matters: an address on a tunnel that is not
   * up yet is unreachable, where the public one still works.
   */
  enrolled: boolean;
}

export interface ManagementAddress {
  address: string;
  path: ManagementPath;
  /** Human-readable justification for logs. Never parsed. */
  reason: string;
}

interface VNetRef {
  vnetId?: string;
  subnetId?: string;
}

export interface AddressableCluster {
  name?: string;
  provider: string;
  metadata?: Record<string, unknown> | null;
  masterIpAddress?: string | null;
  masterPrivateIp?: string | null;
}

export interface NodeOverlayContext {
  nodeAddress: string;
  enrolled: boolean;
}

export interface AddressableNode {
  ipAddress?: string | null;
  privateIp?: string | null;
}

/**
 * The single answer to "what address does one cluster use to reach another".
 *
 * Every caller goes through here so the kubeconfig endpoint, the telemetry
 * target and the firewall rules cannot disagree: a public endpoint without the
 * rule that opens it leaves a cluster unmanageable, and a private one that is
 * not actually shared drops telemetry with no failure path back to the user.
 *
 * Adding a transport means extending `ManagementPath` and this class, not
 * teaching four call sites a new rule.
 */
@Injectable()
export class ManagementAddressResolver {
  /**
   * How two clusters are placed relative to each other's private network.
   *
   * Deliberately three-valued: a cluster whose VNet was never recorded still
   * has a working private network with its same-provider peers, so `unknown`
   * must not collapse into `separate`.
   *
   * The two callers resolve `unknown` in opposite directions, because their
   * errors cost different things — see `controlEndpointFor` and
   * `apiServerEndpointFor`.
   */
  privateNetworkRelation(
    a: AddressableCluster,
    b: AddressableCluster,
  ): 'shared' | 'separate' | 'unknown' {
    if (a.provider !== b.provider) return 'separate';
    const va = this.vnetRef(a);
    const vb = this.vnetRef(b);
    if (!va?.vnetId || !vb?.vnetId) return 'unknown';
    if (va.vnetId !== vb.vnetId) return 'separate';
    if (va.subnetId && vb.subnetId && va.subnetId !== vb.subnetId) {
      return 'separate';
    }
    return 'shared';
  }

  /** Positive proof of a shared private network. `unknown` is not proof. */
  sharesPrivateNetwork(a: AddressableCluster, b: AddressableCluster): boolean {
    return this.privateNetworkRelation(a, b) === 'shared';
  }

  /**
   * The address a workload cluster uses to reach the control cluster — the
   * telemetry push target, and the source the control's firewall must allow.
   *
   * Identical for master and worker nodes on purpose: a node's role has no
   * bearing on which network reaches the control cluster.
   */
  controlEndpointFor(
    workload: AddressableCluster,
    control: AddressableCluster,
    overlay?: OverlayContext,
  ): ManagementAddress | undefined {
    const relation = this.privateNetworkRelation(workload, control);
    // The tunnel wins over a guess, but not over a private network that is
    // already there: two clusters sharing one costs nothing to use, and routing
    // them through WireGuard would add encapsulation for no gain.
    if (overlay?.enrolled && relation !== 'shared') {
      return {
        address: overlay.controlAddress,
        path: 'wireguard',
        reason:
          relation === 'separate'
            ? 'no shared private network — using the management overlay'
            : 'no VNet recorded on one side — the overlay is the known-good path',
      };
    }
    // `unknown` resolves to private here: dropped logs are repaired by the
    // next reconcile, whereas the public address hits ingest ports closed by
    // default and loses them for good.
    if (relation !== 'separate') {
      const priv = this.trim(control.masterPrivateIp);
      if (priv) {
        return {
          address: priv,
          path: 'private',
          reason:
            relation === 'shared'
              ? 'shares a private network with the control cluster'
              : 'no VNet recorded on one side — keeping the private path',
        };
      }
    }
    const pub = this.publicAddressOf(control);
    if (!pub) return undefined;
    return {
      address: pub,
      path: 'public',
      reason:
        relation === 'separate'
          ? 'no shared private network with the control cluster'
          : 'the control cluster has no private IP recorded',
    };
  }

  /**
   * The address the control cluster uses to reach a workload's API server —
   * what gets baked into the stored kubeconfig, and what decides whether a
   * public 6443 firewall rule is required.
   *
   * A control cluster addresses its own API over its private IP; it is the
   * workload case that can need the public one.
   */
  apiServerEndpointFor(
    workload: AddressableCluster,
    node: AddressableNode,
    control: AddressableCluster | null | undefined,
    overlay?: NodeOverlayContext,
  ): ManagementAddress | undefined {
    const priv = this.trim(node.privateIp);
    const pub = this.trim(node.ipAddress);

    // Moving the API server onto the overlay also requires the address to be in
    // the server certificate's SANs, which is why the caller supplies this
    // rather than the resolver assuming it: a cluster installed before that was
    // true would answer on the address with a certificate that does not name it.
    if (overlay?.enrolled && control) {
      if (this.privateNetworkRelation(workload, control) !== 'shared') {
        return {
          address: overlay.nodeAddress,
          path: 'wireguard',
          reason: 'reachable over the management overlay',
        };
      }
    }

    if (!control) {
      const fallback = priv ?? pub;
      return fallback
        ? {
            address: fallback,
            path: priv ? 'private' : 'public',
            reason: 'no control cluster resolved — defaulting to the node IP',
          }
        : undefined;
    }

    // Only positive proof of a shared network earns the private address: an
    // unreachable private endpoint in a kubeconfig makes the cluster
    // unmanageable with no error anywhere, which is worse than a public
    // endpoint on a port that is mTLS-authenticated anyway.
    if (this.sharesPrivateNetwork(workload, control) && priv) {
      return {
        address: priv,
        path: 'private',
        reason: 'shares a private network with the control cluster',
      };
    }

    if (!pub) {
      return priv
        ? {
            address: priv,
            path: 'private',
            reason: 'no public IP recorded for the node',
          }
        : undefined;
    }

    return {
      address: pub,
      path: 'public',
      reason: 'no shared private network with the control cluster',
    };
  }

  /**
   * True when the control must open a public path to this workload's API
   * server. Derived from the same call the kubeconfig makes, so a cluster can
   * never end up with a public endpoint and no rule to reach it.
   */
  requiresPublicApiServerRule(
    workload: AddressableCluster,
    node: AddressableNode,
    control: AddressableCluster | null | undefined,
    overlay?: NodeOverlayContext,
  ): boolean {
    return (
      this.apiServerEndpointFor(workload, node, control, overlay)?.path ===
      'public'
    );
  }

  /**
   * The address of a cluster as seen from outside its own network. For BYOS the
   * reachable host is the operator-declared one: `masterIpAddress` there can be
   * an internal address (a Podman bridge, for instance) that nothing external
   * can route to.
   */
  publicAddressOf(cluster: AddressableCluster): string | undefined {
    const byosHost = (
      cluster.metadata as { byos?: { host?: string } } | null | undefined
    )?.byos?.host;
    return this.trim(byosHost) ?? this.trim(cluster.masterIpAddress);
  }

  private vnetRef(cluster: AddressableCluster): VNetRef | undefined {
    return (cluster.metadata as { vnetConfig?: VNetRef } | null | undefined)
      ?.vnetConfig;
  }

  private trim(value: string | null | undefined): string | undefined {
    const t = value?.trim();
    return t ? t : undefined;
  }
}
