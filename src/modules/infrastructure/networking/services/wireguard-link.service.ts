import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { ClusterEntity } from '../../clusters/entities/cluster.entity';
import { HostCommandService } from '../../../providers/core/host/host-command.service';
import { HostTarget } from '../../../providers/core/host/host-targets';
import { CrossProviderFirewallService } from '../../firewalls/services/cross-provider-firewall.service';
import {
  WG_LINK_SERVICE_PORT_MAX,
  WG_LINK_SERVICE_PORT_MIN,
  WireGuardLinkEntity,
  WireGuardLinkState,
} from '../entities/wireguard-link.entity';
import { WireGuardPeerEntity } from '../entities/wireguard-peer.entity';
import { WG_DEFAULT_PORT } from '../wireguard-config';
import {
  APPLIED_MARKER,
  UNSUPPORTED_MARKER,
  buildApplyScript,
  isHandshakeFresh,
} from '../wireguard-host';
import { WireGuardPeerService } from './wireguard-peer.service';
import { WireGuardHubService } from './wireguard-hub.service';
import { pairNodesWithTargets } from './wireguard-node-targets';

export interface OpenLinkInput {
  purpose: string;
  ownerId: string;
  listenerNodeId: string;
  dialerNodeId: string;
}

interface LinkEnd {
  nodeId: string;
  clusterId: string;
  peer?: WireGuardPeerEntity;
  target?: HostTarget;
}

const HANDSHAKE_TIMEOUT_MS = 120_000;
const HANDSHAKE_POLL_MS = 5_000;

/**
 * Opens, checks and closes temporary direct links between two member nodes.
 *
 * The link is desired state, not an imperative `wg set`: both nodes' configs
 * are rendered from `wg_links`, so the periodic reconcile writes the same
 * file and never strips the peer, and a link that is no longer open
 * disappears on the next pass even if a close stopped halfway.
 */
@Injectable()
export class WireGuardLinkService {
  private readonly logger = new Logger(WireGuardLinkService.name);

  constructor(
    @InjectRepository(WireGuardLinkEntity)
    private readonly links: Repository<WireGuardLinkEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly peerService: WireGuardPeerService,
    private readonly hostCommand: HostCommandService,
    private readonly hub: WireGuardHubService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  async get(linkId: string): Promise<WireGuardLinkEntity> {
    const link = await this.links.findOne({ where: { id: linkId } });
    if (!link)
      throw new NotFoundException(`WireGuard link ${linkId} not found`);
    return link;
  }

  /** Idempotent per owner: the live link of `ownerId` is converged again and returned. */
  async open(input: OpenLinkInput): Promise<WireGuardLinkEntity> {
    const existing = await this.links.findOne({
      where: { ownerId: input.ownerId, state: Not(WireGuardLinkState.CLOSED) },
    });
    if (existing) {
      if (existing.state !== WireGuardLinkState.OPEN) {
        throw new BadRequestException(
          `The link of ${input.ownerId} is still closing — retry once it has closed`,
        );
      }
      await this.converge(existing.id);
      return existing;
    }
    if (input.listenerNodeId === input.dialerNodeId) {
      throw new BadRequestException('A link needs two different nodes');
    }

    const live = await this.peerService.livePeers();
    const listener = live.find((p) => p.nodeId === input.listenerNodeId);
    const dialer = live.find((p) => p.nodeId === input.dialerNodeId);
    if (!listener?.publicKey || !dialer?.publicKey) {
      throw new BadRequestException(
        'Both nodes must be enrolled on the Flui network with a key before they can be linked',
      );
    }
    if (!listener.endpointHost) {
      throw new BadRequestException(
        `Node ${input.listenerNodeId} has no public address the other node could dial`,
      );
    }
    if (listener.subnetId && listener.subnetId === dialer.subnetId) {
      throw new BadRequestException(
        'The two nodes already peer in the same Flui subnet',
      );
    }

    const link = await this.links.save(
      this.links.create({
        purpose: input.purpose,
        ownerId: input.ownerId,
        listenerNodeId: input.listenerNodeId,
        listenerClusterId: listener.clusterId,
        dialerNodeId: input.dialerNodeId,
        dialerClusterId: dialer.clusterId,
        listenPort: listener.listenPort ?? WG_DEFAULT_PORT,
        serviceTcpPort: await this.freeServicePort(input.listenerNodeId),
        dialerEgressIp: await this.dialerEgressIp(dialer),
        state: WireGuardLinkState.OPEN,
        openedAt: new Date(),
      }),
    );
    this.logger.log(
      `[wg-link] ${link.id} open: ${listener.managementIp} listens, ${dialer.managementIp} dials (${input.purpose})`,
    );
    await this.converge(link.id);
    return link;
  }

  /**
   * Firewall first, then the listener, then the dialer: the listener must be
   * reachable and listening before the dialer starts sending.
   */
  async converge(linkId: string): Promise<void> {
    const link = await this.get(linkId);
    await this.admit(link.listenerClusterId);
    const listener = await this.end(
      link.listenerClusterId,
      link.listenerNodeId,
    );
    const dialer = await this.end(link.dialerClusterId, link.dialerNodeId);
    for (const end of [listener, dialer]) {
      if (!end.target) {
        throw new BadRequestException(
          `Node ${end.nodeId} has no SSH endpoint Flui can reach`,
        );
      }
      await this.applyOn(end);
    }
  }

  /** Both ends must report a fresh handshake with the other's key. */
  async awaitHandshake(
    linkId: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<WireGuardLinkEntity> {
    const link = await this.get(linkId);
    const listener = await this.end(
      link.listenerClusterId,
      link.listenerNodeId,
    );
    const dialer = await this.end(link.dialerClusterId, link.dialerNodeId);
    if (!listener.target || !dialer.target || !listener.peer || !dialer.peer) {
      throw new BadRequestException(
        `Link ${link.id}: one of its nodes is not reachable or not enrolled`,
      );
    }
    const deadline = Date.now() + (opts.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    for (;;) {
      const seenByListener = await this.handshakeWith(
        listener.target,
        dialer.peer.publicKey,
      );
      const seenByDialer = await this.handshakeWith(
        dialer.target,
        listener.peer.publicKey,
      );
      if (seenByListener && seenByDialer) {
        link.lastHandshakeAt =
          seenByListener < seenByDialer ? seenByListener : seenByDialer;
        return this.links.save(link);
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Link ${link.id}: no handshake between ${listener.peer.managementIp} and ` +
            `${dialer.peer.managementIp} (listener ${sawIt(seenByListener)}, ` +
            `dialer ${sawIt(seenByDialer)})`,
        );
      }
      await new Promise((r) => setTimeout(r, opts.pollMs ?? HANDSHAKE_POLL_MS));
    }
  }

  /**
   * Withdraws the link. The firewall rule goes before any host is touched, so
   * the exposure ends even when a host cannot be reached; the row stays
   * `closing` until neither host lists the other's key.
   */
  async close(linkId: string, reason?: string): Promise<WireGuardLinkEntity> {
    const link = await this.get(linkId);
    if (link.state === WireGuardLinkState.CLOSED) return link;
    if (link.state !== WireGuardLinkState.CLOSING || reason) {
      link.state = WireGuardLinkState.CLOSING;
      if (reason) link.closeReason = reason;
      await this.links.save(link);
    }

    try {
      await this.admit(link.listenerClusterId);
    } catch (error) {
      this.logger.warn(
        `[wg-link] ${link.id}: firewall not updated yet: ${(error as Error).message}`,
      );
    }

    const listener = await this.end(
      link.listenerClusterId,
      link.listenerNodeId,
    );
    const dialer = await this.end(link.dialerClusterId, link.dialerNodeId);
    let clean = true;
    for (const [self, other] of [
      [listener, dialer],
      [dialer, listener],
    ] as const) {
      if (!(await this.withdrawFrom(link, self, other))) clean = false;
    }

    if (clean) {
      link.state = WireGuardLinkState.CLOSED;
      link.closedAt = new Date();
      await this.links.save(link);
      this.logger.log(`[wg-link] ${link.id} closed`);
    }
    return link;
  }

  /**
   * Retries links stuck closing, and closes open links one of whose nodes has
   * left the overlay (cluster deleted, node revoked).
   */
  async sweep(): Promise<{ closed: number; pending: number }> {
    const rows = await this.links.find({
      where: {
        state: In([WireGuardLinkState.OPEN, WireGuardLinkState.CLOSING]),
      },
    });
    if (!rows.length) return { closed: 0, pending: 0 };
    const live = new Set(
      (await this.peerService.livePeers())
        .filter((p) => p.nodeId)
        .map((p) => p.nodeId as string),
    );
    let closed = 0;
    let pending = 0;
    for (const row of rows) {
      let reason: string | undefined;
      if (row.state === WireGuardLinkState.OPEN) {
        const gone = [row.listenerNodeId, row.dialerNodeId].filter(
          (id) => !live.has(id),
        );
        if (!gone.length) continue;
        reason = `node ${gone.join(', ')} left the Flui network`;
      }
      try {
        const after = await this.close(row.id, reason);
        if (after.state === WireGuardLinkState.CLOSED) closed += 1;
        else pending += 1;
      } catch (error) {
        pending += 1;
        this.logger.warn(
          `[wg-link] sweep of ${row.id} failed: ${(error as Error).message}`,
        );
      }
    }
    return { closed, pending };
  }

  private async admit(clusterId: string): Promise<void> {
    const firewall = this.moduleRef?.get(CrossProviderFirewallService, {
      strict: false,
    });
    if (firewall) await firewall.admitLinks(clusterId);
  }

  /** True once `self` no longer lists `other`, or has nothing Flui can reach. */
  private async withdrawFrom(
    link: WireGuardLinkEntity,
    self: LinkEnd,
    other: LinkEnd,
  ): Promise<boolean> {
    if (!self.peer || !self.target) return true;
    try {
      await this.applyOn(self);
      if (other.peer?.publicKey) {
        const state = await this.hub.readState(self.target);
        if (state.peers.some((p) => p.publicKey === other.peer?.publicKey))
          return false;
      }
      return true;
    } catch (error) {
      this.logger.warn(
        `[wg-link] ${link.id}: node ${self.nodeId} not cleaned yet: ${(error as Error).message}`,
      );
      return false;
    }
  }

  private async applyOn(end: LinkEnd): Promise<void> {
    const config = await this.peerService.renderConfigFor(end.nodeId);
    const out = await this.hostCommand.apply(
      end.target as HostTarget,
      buildApplyScript(config),
      APPLIED_MARKER,
    );
    if (out.includes(UNSUPPORTED_MARKER)) {
      throw new BadRequestException(`Node ${end.nodeId} cannot run WireGuard`);
    }
  }

  private async handshakeWith(
    target: HostTarget,
    publicKey: string,
  ): Promise<Date | undefined> {
    const state = await this.hub.readState(target);
    const peer = state.peers.find((p) => p.publicKey === publicKey);
    return peer && isHandshakeFresh(peer) ? peer.latestHandshakeAt : undefined;
  }

  private async end(clusterId: string, nodeId: string): Promise<LinkEnd> {
    const peer = (await this.peerService.livePeers()).find(
      (p) => p.nodeId === nodeId,
    );
    const cluster = await this.clusters.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    let target: HostTarget | undefined;
    if (cluster && !cluster.deletedAt) {
      try {
        target = pairNodesWithTargets(cluster, this.logger).find(
          (p) => p.node.id === nodeId,
        )?.target;
      } catch {
        target = undefined;
      }
    }
    return { nodeId, clusterId, peer, target };
  }

  private async freeServicePort(listenerNodeId: string): Promise<number> {
    const taken = new Set(
      (
        await this.links.find({
          where: {
            listenerNodeId,
            state: Not(WireGuardLinkState.CLOSED),
          },
        })
      ).map((l) => l.serviceTcpPort),
    );
    for (
      let port = WG_LINK_SERVICE_PORT_MIN;
      port <= WG_LINK_SERVICE_PORT_MAX;
      port++
    ) {
      if (!taken.has(port)) return port;
    }
    throw new BadRequestException(
      `Node ${listenerNodeId} has no free link port left`,
    );
  }

  private async dialerEgressIp(
    dialer: WireGuardPeerEntity,
  ): Promise<string | null> {
    if (dialer.endpointHost?.trim()) return dialer.endpointHost.trim();
    const cluster = await this.clusters.findOne({
      where: { id: dialer.clusterId },
      relations: ['nodes'],
    });
    const node = (cluster?.nodes ?? []).find((n) => n.id === dialer.nodeId);
    return node?.ipAddress?.trim() || null;
  }
}

function sawIt(seen: Date | undefined): string {
  return seen ? 'saw it' : 'did not';
}
