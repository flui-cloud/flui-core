import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UserEntity } from '../../../auth/entities/user.entity';
import { UserEventsGateway } from '../../../auth/gateway/user-events.gateway';
import { ClusterEntity } from '../../clusters/entities/cluster.entity';
import { HandshakeTransition } from './wireguard-peer.service';

export const QUIET_ALERT = 'FluiNetworkMemberQuiet';

/**
 * Tells the administrators when a member of the Flui network goes quiet, and
 * again when it comes back, on the same bell as every other alert. Never
 * throws: a bell that cannot ring must not undo the pass it rings about.
 */
@Injectable()
export class FluiNetworkBellService {
  private readonly logger = new Logger(FluiNetworkBellService.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  async ring(transitions: HandshakeTransition[]): Promise<void> {
    if (!transitions.length) return;
    try {
      const gateway = this.moduleRef?.get(UserEventsGateway, { strict: false });
      if (!gateway) return;
      const ids = [...new Set(transitions.map((t) => t.peer.clusterId))];
      const names = new Map(
        (
          await this.clusters.find({
            where: { id: In(ids) },
            select: { id: true, name: true },
          })
        ).map((c) => [c.id, c.name]),
      );
      const admins = await this.users.find({
        where: { isAdmin: true },
        select: { id: true },
      });
      for (const t of transitions) {
        const cluster = names.get(t.peer.clusterId) ?? 'a cluster';
        const summary =
          t.kind === 'went-quiet'
            ? `${cluster} (${t.peer.managementIp}) stopped answering on the Flui network. Flui is repairing it; until then it cannot be managed over the tunnel.`
            : `${cluster} (${t.peer.managementIp}) is answering on the Flui network again.`;
        for (const admin of admins) {
          gateway.emitAlert(admin.id, {
            id: `flui-network:${t.peer.id}`,
            kind: t.kind === 'went-quiet' ? 'fired' : 'resolved',
            alertname: QUIET_ALERT,
            severity: 'warning',
            summary,
            applicationId: null,
            applicationSlug: null,
            startsAt: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      this.logger.warn(
        `[flui-network] quiet members not announced: ${(err as Error).message}`,
      );
    }
  }
}
