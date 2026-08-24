import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Inject, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { WsAuthService } from '../../auth/services/ws-auth.service';
import { installWsAuth } from '../../auth/utils/ws-auth-middleware.util';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { SECTION } from '../../iam/constants/iam-sections';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import {
  IssuerStatusDto,
  IssuerConfiguredDto,
  IssuerConfigurationFailedDto,
  IssuerDeletedDto,
  IssuerDeletionFailedDto,
} from '../dto/cluster-events.dto';
import { WS_CORS } from '../../../config/cors-origin.config';
import {
  carriesAdminReach,
  ceilingWithholds,
} from '../../auth/utils/credential-ceiling.util';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

/**
 * WebSocket Gateway for real-time cluster DNS/certificate events.
 *
 * Emits events when ClusterIssuers are being configured and when
 * cert-manager reports them as ready (ACME registration complete).
 *
 * Namespace: /clusters
 * Room naming: cluster:{clusterId}
 *
 * The room is the instance's, not a tenant's: what it carries is the state of
 * the cluster's ACME issuers and the certificates they mint. It was the last
 * subscription on any gateway that asked nothing at all — any authenticated
 * socket, a sandbox guest included, named any cluster id and was joined. It
 * hands over nobody else's *tenancy*, which is why it is the smallest of the
 * four, but it is still the operator's plumbing narrated live to whoever asks.
 *
 * The question is the area those events belong to, at the level that runs it.
 * A guest holds `infrastructure` read-only — that is how it sees the section at
 * all — so a level check is what tells the two apart.
 */
@WebSocketGateway({
  cors: WS_CORS,
  namespace: '/clusters',
})
export class ClusterDnsGateway implements OnGatewayInit {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ClusterDnsGateway.name);

  constructor(
    private readonly wsAuth: WsAuthService,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  afterInit(server: Server): void {
    installWsAuth(server, this.wsAuth, this.logger);
  }

  // ── Subscription ───────────────────────────────────────────────────────────

  @SubscribeMessage('subscribe:cluster')
  async handleSubscribe(
    @MessageBody() data: { clusterId: string },
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const { clusterId } = data;
    const user = client.data.user as AuthenticatedUser | undefined;

    if (!(await this.mayWatchCluster(user))) {
      this.logger.warn(
        `Client ${client.id} (user=${user?.userId}) refused cluster ${clusterId}`,
      );
      client.emit('subscription:refused', { clusterId, reason: 'not_found' });
      return;
    }

    const roomName = `cluster:${clusterId}`;
    client.join(roomName);
    this.logger.log(`Client ${client.id} subscribed to cluster ${clusterId}`);
    client.emit('subscribed', { clusterId, room: roomName });
  }

  private async mayWatchCluster(
    user: AuthenticatedUser | undefined,
  ): Promise<boolean> {
    if (!user) return false;
    // Decision 119. `cluster:manage` because that is what the Infrastructure
    // section gate below already demands, so the ceiling asks the same question
    // the section does — and `mcp:backup:write`, which carries `cluster:manage`
    // by construction, still passes.
    if (ceilingWithholds(user, IAM_PERMISSION.CLUSTER_MANAGE)) return false;
    if (carriesAdminReach(user)) return true;
    const sections = await this.policy.resolveSectionAccess({
      userId: user.userId,
      email: user.email,
      role: user.role,
      isAdmin: false,
      scopes: user.scopes,
    });
    return (
      sections.find((s) => s.key === SECTION.INFRASTRUCTURE)?.level === 'full'
    );
  }

  @SubscribeMessage('unsubscribe:cluster')
  handleUnsubscribe(
    @MessageBody() data: { clusterId: string },
    @ConnectedSocket() client: Socket,
  ): void {
    const { clusterId } = data;
    const roomName = `cluster:${clusterId}`;
    client.leave(roomName);
    this.logger.log(
      `Client ${client.id} unsubscribed from cluster ${clusterId}`,
    );
    client.emit('unsubscribed', { clusterId });
  }

  // ── Issuer events ──────────────────────────────────────────────────────────

  emitIssuerStatus(clusterId: string, dto: IssuerStatusDto): void {
    this.server.to(`cluster:${clusterId}`).emit('cluster:issuer:status', dto);
    this.logger.debug(
      `[${clusterId}] issuer status: ${dto.issuerName} ready=${dto.ready}`,
    );
  }

  emitIssuerConfigured(clusterId: string, dto: IssuerConfiguredDto): void {
    this.server
      .to(`cluster:${clusterId}`)
      .emit('cluster:issuer:configured', dto);
    this.logger.log(`[${clusterId}] issuers configured in ${dto.duration}ms`);
  }

  emitIssuerConfigurationFailed(
    clusterId: string,
    dto: IssuerConfigurationFailedDto,
  ): void {
    this.server.to(`cluster:${clusterId}`).emit('cluster:issuer:failed', dto);
    this.logger.error(
      `[${clusterId}] issuer configuration failed: ${dto.error}`,
    );
  }

  // ── Endpoint certificate events ────────────────────────────────────────────

  emitEndpointCertStatus(
    clusterId: string,
    dto: {
      clusterId: string;
      endpointId: string;
      fqdn: string;
      certificateStatus: string;
      certificateMessage: string | null;
      tlsEnabled: boolean;
      timestamp: Date;
    },
  ): void {
    this.server
      .to(`cluster:${clusterId}`)
      .emit('cluster:endpoint:cert:status', dto);
    this.logger.debug(
      `[${clusterId}] endpoint ${dto.endpointId} cert status: ${dto.certificateStatus}`,
    );
  }

  // ── Issuer deletion events ─────────────────────────────────────────────────

  emitIssuerDeleted(clusterId: string, dto: IssuerDeletedDto): void {
    this.server.to(`cluster:${clusterId}`).emit('cluster:issuer:deleted', dto);
    this.logger.log(
      `[${clusterId}] issuers deleted: ${dto.deletedIssuers.join(', ')}`,
    );
  }

  emitIssuerDeletionFailed(
    clusterId: string,
    dto: IssuerDeletionFailedDto,
  ): void {
    this.server
      .to(`cluster:${clusterId}`)
      .emit('cluster:issuer:deletion_failed', dto);
    this.logger.error(`[${clusterId}] issuer deletion failed: ${dto.error}`);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
  }
}
