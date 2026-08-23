import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import { IamPrincipal } from '../../iam/interfaces/iam.types';
import { ClusterNodeEntity } from '../../infrastructure/clusters/entities/cluster-node.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { ServerEntity } from '../../infrastructure/servers/entities/server.entity';

/** Where the shell will actually be opened — read from Flui's own rows, never from the client. */
export interface TerminalTarget {
  serverIp: string;
  clusterId?: string;
  describedAs: string;
}

/**
 * Who may be handed a root shell on which machine.
 *
 * `terminal:connect` used to take `serverId`, `serverIp` and `clusterId` from
 * the message and open an SSH session with a certificate signed by the CA,
 * without asking anything about the caller. Two things made that worse than it
 * sounds: the socket accepts **any** authenticated principal — a sandbox guest
 * included — because `installWsAuth` only proves who you are; and
 * `SandboxFenceGuard` is an HTTP guard, so the route fence is not in this path
 * at all. The feature being off by default was the only thing standing there,
 * and a defence that depends on nobody switching a variable on is the most
 * fragile kind.
 *
 * Two separate corrections live here, and the second matters as much as the
 * first:
 *
 * 1. **The target is resolved, then owned.** The id is looked up in Flui's own
 *    tables and the cluster it belongs to is the thing permission is asked
 *    about — `cluster:manage`, which is what a root shell on a control-plane
 *    node is worth. A server that belongs to no cluster is answerable only at
 *    global scope, which is the closed-by-default reading.
 *
 * 2. **The address comes back from the row, not from the message.** Honouring
 *    the client's `serverIp` would leave the whole hole open behind a valid id:
 *    name a machine you may reach, hand over any address you like, and the
 *    certificate is signed for that. The same goes for `clusterId`, which
 *    selects the bootstrap private key to unseal.
 *
 * A refusal is worded as an absence, like the two WebSocket gateways repaired
 * before this one: whose a machine is must not be learnable by asking.
 */
@Injectable()
export class TerminalTargetResolver {
  private readonly logger = new Logger(TerminalTargetResolver.name);

  constructor(
    @InjectRepository(ClusterNodeEntity)
    private readonly nodes: Repository<ClusterNodeEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(ServerEntity)
    private readonly servers: Repository<ServerEntity>,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  async resolve(
    user: AuthenticatedUser | undefined,
    serverId: string | undefined,
  ): Promise<TerminalTarget | null> {
    if (!user || !serverId) return null;

    const node = await this.findNode(serverId);
    if (node) {
      const cluster = await this.clusters.findOne({
        where: { id: node.clusterId },
      });
      if (!node.ipAddress) return null;
      const allowed = await this.mayManage(user, {
        clusterId: node.clusterId,
        clusterName: cluster?.name,
        provider: cluster?.provider,
      });
      if (!allowed) return this.refused(user, serverId);
      return {
        serverIp: node.ipAddress,
        clusterId: node.clusterId,
        describedAs: `node ${node.serverName} of cluster ${node.clusterId}`,
      };
    }

    const server = await this.findServer(serverId);
    if (!server?.ipAddress) return null;
    // No cluster to scope the question to, so only a grant that holds
    // everywhere answers it.
    const allowed = await this.mayManage(user, { provider: server.provider });
    if (!allowed) return this.refused(user, serverId);
    return {
      serverIp: server.ipAddress,
      clusterId: undefined,
      describedAs: `server ${server.name}`,
    };
  }

  private refused(user: AuthenticatedUser, serverId: string): null {
    this.logger.warn(
      `Terminal refused: user=${user.userId} asked for server ${serverId}`,
    );
    return null;
  }

  private async mayManage(
    user: AuthenticatedUser,
    resource: { clusterId?: string; clusterName?: string; provider?: string },
  ): Promise<boolean> {
    const principal: IamPrincipal = {
      userId: user.userId,
      email: user.email,
      role: user.role,
      isAdmin: !!user.isAdmin,
      scopes: user.scopes,
    };
    return this.policy.check(
      principal,
      IAM_PERMISSION.CLUSTER_MANAGE,
      resource,
    );
  }

  /**
   * Three spellings reach this gateway for the same machine: the dashboard
   * sends `providerId || id` (`instance-detail.component.ts`), and the quick
   * overlay sends whatever the session it opened carries. Reading only one of
   * them would turn the check into a miss and refuse a legitimate operator.
   */
  private async findNode(serverId: string): Promise<ClusterNodeEntity | null> {
    const byProviderId = await this.nodes.findOne({
      where: { providerResourceId: serverId },
    });
    if (byProviderId) return byProviderId;
    if (!isUuid(serverId)) return null;
    return this.nodes.findOne({ where: { id: serverId } });
  }

  private async findServer(serverId: string): Promise<ServerEntity | null> {
    const byProviderId = await this.servers.findOne({
      where: { providerResourceId: serverId },
    });
    if (byProviderId) return byProviderId;
    if (!isUuid(serverId)) return null;
    return this.servers.findOne({ where: { id: serverId } });
  }
}

// `infrastructure_servers.id` is a uuid column: handing Postgres anything else
// raises instead of answering "no such row", which would turn a refusal into a
// 500 and tell the caller their guess was interesting.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID.test(value);
}
