import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterFirewallEntity } from '../../infrastructure/firewalls/entities/cluster-firewall.entity';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { ApplicationAccessService } from './application-access.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import {
  AppUdpPort,
  isAppUdpPort,
  UdpPortStatus,
  udpPortStates,
} from '../../../common/net/public-udp';

export interface AppUdpPortsView {
  applicationId: string;
  clusterId: string;
  /** The cluster firewall that has to open them; null when the cluster has none Flui manages. */
  firewallId: string | null;
  ports: UdpPortStatus[];
}

export interface UdpPortsPreview {
  clusterId: string;
  firewallId: string | null;
  /** `takenBy`: the app on this cluster that already holds the port, which refuses the install. */
  ports: Array<UdpPortStatus & { takenBy: string | null }>;
}

@Injectable()
export class AppUdpPortsService {
  constructor(
    private readonly applications: ApplicationsRepository,
    private readonly access: ApplicationAccessService,
    @InjectRepository(ClusterFirewallEntity)
    private readonly firewalls: Repository<ClusterFirewallEntity>,
  ) {}

  async view(
    user: AuthenticatedUser,
    applicationId: string,
  ): Promise<AppUdpPortsView> {
    const app = await this.applications.findById(applicationId);
    if (!app) throw new NotFoundException('Application not found');
    await this.access.assertCan(user, 'app:read', app);
    const { firewallId, ports } = await this.statesFor(
      app.clusterId,
      app.udpPorts ?? [],
      !!app.securityContext?.guestBaseline,
    );
    return {
      applicationId: app.id,
      clusterId: app.clusterId,
      firewallId,
      ports,
    };
  }

  async preview(
    clusterId: string,
    requested: AppUdpPort[],
    guest: boolean,
  ): Promise<UdpPortsPreview> {
    const { firewallId, ports } = await this.statesFor(
      clusterId,
      requested,
      guest,
    );
    if (!ports.length) return { clusterId, firewallId, ports: [] };
    const holders = await this.applications.findUdpPortHolders(clusterId);
    return {
      clusterId,
      firewallId,
      ports: ports.map((p) => ({
        ...p,
        takenBy:
          holders.find((h) => h.udpPorts?.some((u) => u.port === p.port))
            ?.slug ?? null,
      })),
    };
  }

  private async statesFor(
    clusterId: string,
    ports: AppUdpPort[],
    guest: boolean,
  ): Promise<{ firewallId: string | null; ports: UdpPortStatus[] }> {
    const declared = ports.filter((p) => isAppUdpPort(p.port));
    if (!declared.length) return { firewallId: null, ports: [] };
    const firewall = await this.firewalls.findOne({
      where: { clusterId },
      select: { id: true, desiredRules: true, lastAppliedRules: true },
    });
    const firewallId = firewall?.id ?? null;
    if (guest) {
      return {
        firewallId,
        ports: declared.map((p) => ({ ...p, state: 'not-published' })),
      };
    }
    return {
      firewallId,
      ports: udpPortStates(
        declared,
        firewall
          ? {
              desired: firewall.desiredRules ?? [],
              applied: firewall.lastAppliedRules,
            }
          : null,
      ),
    };
  }
}
