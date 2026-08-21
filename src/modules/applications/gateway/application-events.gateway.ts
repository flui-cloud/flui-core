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
  RolloutProgressDto,
  RolloutCompletedDto,
  RolloutFailedDto,
  OperationProgressDto,
  OperationCompletedDto,
  OperationFailedDto,
  BuildStartedDto,
  BuildLogDto,
  BuildPlanDto,
  BuildCompletedDto,
  BuildFailedDto,
  ReleaseStatusChangedDto,
} from '../dto/application-events.dto';
import { WS_CORS } from '../../../config/cors-origin.config';

/**
 * WebSocket Gateway for real-time application events.
 *
 * Covers two event categories:
 *   1. Rollout events — immediate runtime ops (restart, scale, update-resources)
 *      that patch K8s synchronously and then track rollout completion in background.
 *   2. Operation events — long-running async ops via Bull (deploy, rollback)
 *      emitted by the ApplicationDeployProcessor when needed.
 *
 * Namespace: /applications
 * Room naming: application:{appId}
 */
@WebSocketGateway({
  cors: WS_CORS,
  namespace: '/applications',
})
export class ApplicationEventsGateway implements OnGatewayInit {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ApplicationEventsGateway.name);

  constructor(private readonly wsAuth: WsAuthService) {}

  afterInit(server: Server): void {
    installWsAuth(server, this.wsAuth, this.logger);
  }

  // ── Subscription ───────────────────────────────────────────────────────────

  @SubscribeMessage('subscribe:application')
  handleSubscribe(
    @MessageBody() data: { appId: string },
    @ConnectedSocket() client: Socket,
  ): void {
    const { appId } = data;
    const roomName = `application:${appId}`;
    client.join(roomName);
    this.logger.log(`Client ${client.id} subscribed to application ${appId}`);
    client.emit('subscribed', { appId, room: roomName });
  }

  @SubscribeMessage('unsubscribe:application')
  handleUnsubscribe(
    @MessageBody() data: { appId: string },
    @ConnectedSocket() client: Socket,
  ): void {
    const { appId } = data;
    const roomName = `application:${appId}`;
    client.leave(roomName);
    this.logger.log(
      `Client ${client.id} unsubscribed from application ${appId}`,
    );
    client.emit('unsubscribed', { appId });
  }

  @SubscribeMessage('subscribe:build')
  handleBuildSubscribe(
    @MessageBody() data: { buildId: string },
    @ConnectedSocket() client: Socket,
  ): void {
    const { buildId } = data;
    const roomName = `build:${buildId}`;
    client.join(roomName);
    this.logger.log(`Client ${client.id} subscribed to build ${buildId}`);
    client.emit('subscribed', { buildId, room: roomName });
  }

  @SubscribeMessage('unsubscribe:build')
  handleBuildUnsubscribe(
    @MessageBody() data: { buildId: string },
    @ConnectedSocket() client: Socket,
  ): void {
    const { buildId } = data;
    client.leave(`build:${buildId}`);
    this.logger.log(`Client ${client.id} unsubscribed from build ${buildId}`);
    client.emit('unsubscribed', { buildId });
  }

  // ── Rollout events (restart / scale / update-resources) ───────────────────

  emitRolloutProgress(appId: string, dto: RolloutProgressDto): void {
    this.server
      .to(`application:${appId}`)
      .emit('application:rollout:progress', dto);
    this.logger.debug(
      `[${appId}] rollout progress: ${dto.percentage}% (${dto.readyReplicas}/${dto.desiredReplicas})`,
    );
  }

  emitRolloutCompleted(appId: string, dto: RolloutCompletedDto): void {
    this.server
      .to(`application:${appId}`)
      .emit('application:rollout:completed', dto);
    this.logger.log(
      `[${appId}] rollout completed (${dto.operation}) in ${dto.duration}ms`,
    );
  }

  emitRolloutFailed(appId: string, dto: RolloutFailedDto): void {
    this.server
      .to(`application:${appId}`)
      .emit('application:rollout:failed', dto);
    this.logger.error(
      `[${appId}] rollout failed (${dto.operation}): ${dto.error}`,
    );
  }

  // ── Operation events (deploy / rollback — for future processor integration) ─

  emitOperationProgress(appId: string, dto: OperationProgressDto): void {
    this.server
      .to(`application:${appId}`)
      .emit('application:operation:progress', dto);
    this.logger.debug(
      `[${appId}] operation progress: ${dto.operationType} ${dto.percentage}%`,
    );
  }

  emitOperationCompleted(appId: string, dto: OperationCompletedDto): void {
    this.server
      .to(`application:${appId}`)
      .emit('application:operation:completed', dto);
    this.logger.log(
      `[${appId}] operation completed: ${dto.operationType} in ${dto.duration}ms`,
    );
  }

  emitOperationFailed(appId: string, dto: OperationFailedDto): void {
    this.server
      .to(`application:${appId}`)
      .emit('application:operation:failed', dto);
    this.logger.error(
      `[${appId}] operation failed: ${dto.operationType} — ${dto.error}`,
    );
  }

  emitReleaseStatusChanged(appId: string, dto: ReleaseStatusChangedDto): void {
    this.server
      .to(`application:${appId}`)
      .emit('application:release:status', dto);
    this.logger.log(`[${appId}] release ${dto.operationId} → ${dto.status}`);
  }

  // ── Crash diagnosis events ────────────────────────────────────────────────

  emitCrashDiagnosis(appId: string, diagnosis: unknown): void {
    this.server
      .to(`application:${appId}`)
      .emit('application:crash-diagnosis', diagnosis);
    this.logger.warn(`[${appId}] crash diagnosis emitted`);
  }

  emitAutoRemediation(appId: string, payload: unknown): void {
    this.server
      .to(`application:${appId}`)
      .emit('application:auto-remediation', payload);
    this.logger.log(`[${appId}] auto remediation emitted`);
  }

  emitCrashResolved(appId: string, payload: unknown): void {
    this.server
      .to(`application:${appId}`)
      .emit('application:crash-resolved', payload);
    this.logger.log(`[${appId}] crash resolved emitted`);
  }

  // ── Build events (Path B: K3s Job build pipeline) ─────────────────────────

  /**
   * Returns the appropriate room for build events.
   * Standalone builds (no application yet) use room `build:{buildId}`.
   * App-linked builds use room `application:{appId}`.
   */
  private buildRoom(appId: string | null, buildId: string): string {
    return appId ? `application:${appId}` : `build:${buildId}`;
  }

  emitBuildStarted(appId: string | null, dto: BuildStartedDto): void {
    const room = this.buildRoom(appId, dto.buildId);
    this.server.to(room).emit('application:build:started', dto);
    this.logger.log(
      `[${appId ?? dto.buildId}] build started: ${dto.buildId} (branch: ${dto.branch})`,
    );
  }

  emitBuildLog(appId: string | null, dto: BuildLogDto): void {
    const room = this.buildRoom(appId, dto.buildId);
    this.server.to(room).emit('application:build:log', dto);
  }

  emitBuildPlan(appId: string | null, dto: BuildPlanDto): void {
    const room = this.buildRoom(appId, dto.buildId);
    this.server.to(room).emit('application:build:plan', dto);
    this.logger.log(
      `[${appId ?? dto.buildId}] build plan detected: framework=${dto.framework}`,
    );
  }

  emitBuildCompleted(appId: string | null, dto: BuildCompletedDto): void {
    const room = this.buildRoom(appId, dto.buildId);
    this.server.to(room).emit('application:build:completed', dto);
    this.logger.log(
      `[${appId ?? dto.buildId}] build completed: ${dto.imageRef} in ${dto.duration}ms`,
    );
  }

  emitBuildFailed(appId: string | null, dto: BuildFailedDto): void {
    const room = this.buildRoom(appId, dto.buildId);
    this.server.to(room).emit('application:build:failed', dto);
    this.logger.error(`[${appId ?? dto.buildId}] build failed: ${dto.error}`);
  }

  emitBuildHeartbeat(
    appId: string | null,
    buildId: string,
    status: string,
  ): void {
    const room = this.buildRoom(appId, buildId);
    this.server.to(room).emit('application:build:heartbeat', {
      appId,
      buildId,
      status,
      timestamp: new Date(),
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  async getSubscriberCount(appId: string): Promise<number> {
    const sockets = await this.server.in(`application:${appId}`).fetchSockets();
    return sockets.length;
  }
}
