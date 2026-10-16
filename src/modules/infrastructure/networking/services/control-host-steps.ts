import { Logger } from '@nestjs/common';
import { In, Repository } from 'typeorm';
import {
  ClusterNodeEntity,
  NodeStatus,
  NodeType,
} from '../../clusters/entities/cluster-node.entity';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
  isControlClusterType,
} from '../../clusters/entities/cluster.entity';
import { ManagementAddressResolver } from '../../shared/services/management-address.resolver';
import { pairNodesWithTargets } from './wireguard-node-targets';
import { HostCommandService } from '../../../providers/core/host/host-command.service';
import { HostTarget } from '../../../providers/core/host/host-targets';
import { HandshakeTransition } from './wireguard-peer.service';
import {
  WireGuardPeerEntity,
  WireGuardPeerRole,
} from '../entities/wireguard-peer.entity';
import { WG_INTERFACE } from '../wireguard-config';
import {
  KeyScriptOptions,
  READY_MARKER,
  UNSUPPORTED_MARKER,
  buildKeyEnrolmentScript,
  extractPrivateKey,
  extractPublicKey,
} from '../wireguard-host';
import {
  JUMP_APPLIED_MARKER,
  JUMP_REFUSED_MARKER,
  JUMP_UNCHANGED_MARKER,
  buildJumpHostScript,
} from '../jump-host';

export interface ControlNodeState {
  nodeId: string;
  host: string;
  primary: boolean;
  address?: string;
  applied: boolean;
  /** Members this control node has seen a recent handshake from. */
  fresh: number;
  stale: number;
  error?: string;
}

export interface ControlEndState {
  address: string;
  publicKey: string;
  host: string;
  /** Every control node took its config. */
  applied: boolean;
  /** Members the primary has seen a recent handshake from. */
  fresh: number;
  stale: number;
  /** Members that went quiet or came back in this reading. */
  transitions: HandshakeTransition[];
  /** The control as the way in to workload nodes: `applied`, `unchanged`, or why not. */
  jumpHost: string;
  nodes: ControlNodeState[];
}

export type PairedNode = { node: ClusterNodeEntity; target: HostTarget };

export interface ControlHub {
  control: ClusterEntity;
  endpointHost: string;
  primary: PairedNode;
  others: PairedNode[];
}

export interface ControlEnd {
  paired: PairedNode;
  primary: boolean;
  row?: WireGuardPeerEntity;
  error?: string;
}

export interface NodeKeyReading {
  publicKey?: string;
  captured?: string;
  unsupported?: boolean;
  error?: string;
}

/** Makes sure the node owns a keypair and reads back the public half. */
export async function readNodeKey(
  hostCommand: HostCommandService,
  target: HostTarget,
  options: KeyScriptOptions = {},
): Promise<NodeKeyReading> {
  try {
    const out = await hostCommand.apply(
      target,
      buildKeyEnrolmentScript(WG_INTERFACE, options),
      READY_MARKER,
      { timeoutMs: 180_000 },
    );
    if (out.includes(UNSUPPORTED_MARKER)) return { unsupported: true };
    return {
      publicKey: extractPublicKey(out),
      captured: options.capture ? extractPrivateKey(out) : undefined,
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/**
 * The workload nodes the jump user may forward to: members only, never a
 * control node, and nothing on the control cluster itself.
 */
export function jumpMemberAddresses(
  clusters: Pick<ClusterEntity, 'id' | 'clusterType'>[],
  live: WireGuardPeerEntity[],
): string[] {
  const onControl = new Set(
    clusters
      .filter((c) => isControlClusterType(c.clusterType))
      .map((c) => c.id),
  );
  return live
    .filter(
      (p) => p.role === WireGuardPeerRole.MEMBER && !onControl.has(p.clusterId),
    )
    .map((p) => p.managementIp);
}

/**
 * The control master lets a person through to a workload node on its Flui
 * network address, and nowhere else. Refused changes are reported, never
 * forced: the script keeps nothing that would alter how root logs in.
 */
export async function applyJumpHost(
  hostCommand: HostCommandService,
  logger: Logger,
  target: HostTarget,
  members: string[],
): Promise<string> {
  try {
    const out = await hostCommand.run(target, buildJumpHostScript(members), {
      timeoutMs: 60_000,
    });
    if (out.includes(JUMP_APPLIED_MARKER)) return 'applied';
    if (out.includes(JUMP_UNCHANGED_MARKER)) return 'unchanged';
    const refused = out
      .split('\n')
      .find((l) => l.startsWith(JUMP_REFUSED_MARKER))
      ?.slice(JUMP_REFUSED_MARKER.length)
      .trim();
    const reason = refused || 'the script did not finish';
    logger.warn(`[wg] the control did not take the jump user: ${reason}`);
    return `refused: ${reason}`;
  } catch (error) {
    const message = (error as Error).message;
    logger.warn(`[wg] the jump user could not be set up: ${message}`);
    return `failed: ${message}`;
  }
}

/** Where members dial a control node other than the master. */
export function nodeEndpointHost(node: ClusterNodeEntity): string | undefined {
  const byosHost = (node.metadata as { byos?: { host?: string } } | undefined)
    ?.byos?.host;
  return byosHost?.trim() || node.ipAddress?.trim() || undefined;
}

/** A node that is neither being deleted nor failed to join: one to converge. */
export function isLiveNode(node: ClusterNodeEntity): boolean {
  return (
    node.status !== NodeStatus.DELETING && node.status !== NodeStatus.ERROR
  );
}

/**
 * The control cluster's master, the address members dial it on, and its
 * other live nodes. The newest live master is the primary.
 *
 * For BYOS the master's address is the operator-declared host:
 * `masterIpAddress` there can be something nothing outside can route to.
 */
export async function findControlHub(
  clusters: Repository<ClusterEntity>,
  addresses: ManagementAddressResolver,
  logger: Logger,
): Promise<ControlHub | undefined> {
  const control = await clusters.findOne({
    where: {
      clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
      status: ClusterStatus.READY,
    },
    relations: ['nodes'],
    order: { createdAt: 'ASC' },
  });
  if (!control) return undefined;

  const endpointHost = addresses.publicAddressOf(control);
  if (!endpointHost) {
    logger.warn(
      `[wg] the control cluster has no address members could dial — ` +
        `skipping its end of the overlay`,
    );
    return undefined;
  }

  const live = (control.nodes ?? []).filter(isLiveNode);
  const master = live
    .filter((n) => n.nodeType === NodeType.MASTER)
    .sort((a, b) => +(b.createdAt ?? 0) - +(a.createdAt ?? 0))[0];
  const paired = pairNodesWithTargets(control, logger, live);
  const primary = paired.find((p) => p.node.id === master?.id);
  if (!primary) return undefined;
  const others = paired.filter((p) => p !== primary);
  return { control, endpointHost, primary, others };
}
