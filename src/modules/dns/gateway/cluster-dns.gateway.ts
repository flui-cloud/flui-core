import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { WsAuthService } from '../../auth/services/ws-auth.service';
import { installWsAuth } from '../../auth/utils/ws-auth-middleware.util';
import {
  IssuerStatusDto,
  IssuerConfiguredDto,
  IssuerConfigurationFailedDto,
  IssuerDeletedDto,
  IssuerDeletionFailedDto,
} from '../dto/cluster-events.dto';
import { WS_CORS } from '../../../config/cors-origin.config';

/**
 * WebSocket Gateway for real-time cluster DNS/certificate events.
 *
 * Emits events when ClusterIssuers are being configured and when
 * cert-manager reports them as ready (ACME registration complete).
 *
 * Namespace: /clusters
 * Room naming: cluster:{clusterId}
 */
@WebSocketGateway({
  cors: WS_CORS,
  namespace: '/clusters',
})
export class ClusterDnsGateway implements OnGatewayInit {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ClusterDnsGateway.name);

  constructor(private readonly wsAuth: WsAuthService) {}

  afterInit(server: Server): void {
    installWsAuth(server, this.wsAuth, this.logger);
  }

  // ── Subscription ───────────────────────────────────────────────────────────

  @SubscribeMessage('subscribe:cluster')
  handleSubscribe(
    @MessageBody() data: { clusterId: string },
    @ConnectedSocket() client: Socket,
  ): void {
    const { clusterId } = data;
    const roomName = `cluster:${clusterId}`;
    client.join(roomName);
    this.logger.log(`Client ${client.id} subscribed to cluster ${clusterId}`);
    client.emit('subscribed', { clusterId, room: roomName });
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
