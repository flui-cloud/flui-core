import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Server, Socket } from 'socket.io';
import { WsAuthService } from '../../auth/services/ws-auth.service';
import { installWsAuth } from '../../auth/utils/ws-auth-middleware.util';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ApplicationAccessService } from '../services/application-access.service';
import { ApplicationEntity } from '../entities/application.entity';
import { AppBuildEntity } from '../../app-builds/entities/app-build.entity';
import { mayActOnBuild } from '../../app-builds/helpers/build-ownership.helper';
import { InfrastructureOperationEntity } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
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
import {
  carriesAdminReach,
  ceilingWithholds,
} from '../../auth/utils/credential-ceiling.util';

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
 *
 * A room is a subscription to somebody's application, so joining one is a read
 * and is answered like one. It was not: any authenticated socket could name any
 * application id and be joined, and two sandbox guests proved what that
 * delivers — one guest restarted its own app and the other received the rollout
 * progress and the completion snapshot, namespace and deployment name included.
 * The HTTP route for the same data has asked `AppAccessGuard` all along; this
 * asks the service behind it, which is the same question one layer down.
 */
@WebSocketGateway({
  cors: WS_CORS,
  namespace: '/applications',
})
export class ApplicationEventsGateway implements OnGatewayInit {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ApplicationEventsGateway.name);

  constructor(
    private readonly wsAuth: WsAuthService,
    // The repositories and not the services: `actuator.service.ts` imports this
    // gateway only to emit an event, and reaching for `ApplicationService` here
    // pulled the Kubernetes client into every file that does — which is a lot
    // of graph to carry for one ownership question that is two column reads.
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    private readonly access: ApplicationAccessService,
    // The entity, not the module: AppBuildsModule imports this one, so asking
    // its service would close a circle for a lookup that is one column.
    @InjectRepository(AppBuildEntity)
    private readonly builds: Repository<AppBuildEntity>,
    // For the build room only, and for the half of it that has no application:
    // a wizard build belongs to the operation that started it. Repository and
    // policy engine rather than the build module, same reason as above.
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operations: Repository<InfrastructureOperationEntity>,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  afterInit(server: Server): void {
    installWsAuth(server, this.wsAuth, this.logger);
  }

  // ── Subscription ───────────────────────────────────────────────────────────

  @SubscribeMessage('subscribe:application')
  async handleSubscribe(
    @MessageBody() data: { appId: string },
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const { appId } = data;
    const user = client.data.user as AuthenticatedUser | undefined;

    // Worded as a miss, and for the same reason the operation room and the
    // detail routes are: whose application an id belongs to must not be
    // learnable by asking for it.
    if (!(await this.mayReadApplication(appId, client))) {
      this.logger.warn(
        `Client ${client.id} (user=${user?.userId}) refused application ${appId}`,
      );
      client.emit('subscription:refused', { appId, reason: 'not_found' });
      return;
    }

    const roomName = `application:${appId}`;
    client.join(roomName);
    this.logger.log(`Client ${client.id} subscribed to application ${appId}`);
    client.emit('subscribed', { appId, room: roomName });
  }

  private async mayReadApplication(
    appId: string | undefined,
    client: Socket,
  ): Promise<boolean> {
    const user = client.data.user as AuthenticatedUser | undefined;
    if (!appId || !user) return false;
    // Decision 119: a key that declares a ceiling is not the whole person, so
    // it does not inherit the person's admin bypass. Asked before the row is
    // read, so a narrow key learns about its own scopes and not about which
    // applications exist.
    if (ceilingWithholds(user, IAM_PERMISSION.APP_READ)) return false;
    if (carriesAdminReach(user)) return true;
    const app = await this.applications.findOne({ where: { id: appId } });
    // An application nobody has and one somebody else has get the same answer.
    if (!app) return false;
    return this.access.can(user, IAM_PERMISSION.APP_READ, app);
  }

  private mayReadBuild(
    build: AppBuildEntity | null,
    client: Socket,
  ): Promise<boolean> {
    return mayActOnBuild(
      build,
      client.data.user as AuthenticatedUser | undefined,
      IAM_PERMISSION.APP_READ,
      {
        application: (id) => this.applications.findOne({ where: { id } }),
        canOnApplication: (user, action, app) =>
          this.access.can(user, action, app),
        operation: (id) => this.operations.findOne({ where: { id } }),
        policy: this.policy,
      },
    );
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

  /**
   * A build room carries the build's own log lines, which is the most revealing
   * stream on this gateway — commit, source layout, and whatever the build
   * prints. It is answered by whoever the build belongs to, which is the same
   * rule the build routes ask: the application it is for, or — for a wizard
   * build made before any application exists — the operation that started it.
   */
  @SubscribeMessage('subscribe:build')
  async handleBuildSubscribe(
    @MessageBody() data: { buildId: string },
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const { buildId } = data;
    const build = buildId
      ? await this.builds.findOne({ where: { id: buildId } })
      : null;

    if (!(await this.mayReadBuild(build, client))) {
      this.logger.warn(`Client ${client.id} refused build ${buildId}`);
      client.emit('subscription:refused', { buildId, reason: 'not_found' });
      return;
    }

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
