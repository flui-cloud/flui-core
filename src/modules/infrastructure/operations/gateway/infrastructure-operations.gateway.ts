import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Server, Socket } from 'socket.io';
import {
  InfrastructureOperationProgressDto,
  InfrastructureOperationCompletedDto,
  InfrastructureOperationFailedDto,
} from '../dto/infrastructure-operation-events.dto';
import { WsAuthService } from '../../../auth/services/ws-auth.service';
import { installWsAuth } from '../../../auth/utils/ws-auth-middleware.util';
import { WS_CORS } from '../../../../config/cors-origin.config';
import { InfrastructureOperationEntity } from '../../servers/entities/infrastructure-operations.entity';
import { AuthenticatedUser } from '../../../auth/interfaces/authenticated-user.interface';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../../iam/interfaces/policy-engine.interface';
import { mayReadOperation } from '../helpers/operation-ownership.helper';

@WebSocketGateway({
  namespace: '/infrastructure',
  cors: WS_CORS,
})
export class InfrastructureOperationsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(InfrastructureOperationsGateway.name);

  constructor(
    private readonly wsAuth: WsAuthService,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operations: Repository<InfrastructureOperationEntity>,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  afterInit(server: Server): void {
    installWsAuth(server, this.wsAuth, this.logger);
  }

  handleConnection(client: Socket): void {
    this.logger.log(
      `Client connected: ${client.id} (user=${client.data.user?.userId})`,
    );
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /**
   * A room delivers the same progress, completion and failure the HTTP route
   * returns, so it asks the same question the HTTP route asks — `mayReadOperation`
   * is shared, not copied. Authentication alone used to be enough: any socket
   * that guessed an id followed somebody else's provisioning, and the sandbox
   * fence is an HTTP guard (`context.getType() !== 'http'` returns early), so
   * nothing else was in the path either.
   *
   * A refusal is worded like a miss, exactly as the route's 404 is: whose
   * operation it is must not be learnable by asking.
   */
  @SubscribeMessage('subscribe:operation')
  async handleSubscribeOperation(
    @MessageBody() data: { operationId: string },
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const user = client.data.user as AuthenticatedUser | undefined;
    const operation = data?.operationId
      ? await this.operations.findOne({ where: { id: data.operationId } })
      : null;

    if (!(await mayReadOperation(this.policy, operation, user))) {
      this.logger.warn(
        `Client ${client.id} (user=${user?.userId}) refused operation ${data?.operationId}`,
      );
      client.emit('subscription:refused', {
        operationId: data?.operationId,
        reason: 'not_found',
      });
      return;
    }

    const roomName = `operation:${data.operationId}`;
    client.join(roomName);
    this.logger.log(
      `Client ${client.id} subscribed to operation ${data.operationId}`,
    );
    client.emit('subscribed', {
      operationId: data.operationId,
      room: roomName,
    });
  }

  @SubscribeMessage('unsubscribe:operation')
  handleUnsubscribeOperation(
    @MessageBody() data: { operationId: string },
    @ConnectedSocket() client: Socket,
  ): void {
    client.leave(`operation:${data.operationId}`);
    client.emit('unsubscribed', { operationId: data.operationId });
  }

  /**
   * The resource room is the same stream addressed the other way round — every
   * emit goes to both — so it is answered with the same question, asked of the
   * operations recorded against that resource: may you read any of them?
   *
   * Deliberately not the application-access check. The events here are
   * infrastructure operations, and the rule that governs them is ownership of
   * the operation; for a guest the two coincide, because the operations on
   * their application are theirs. Asking the operations table also keeps this
   * gateway from importing the applications module, which would close a
   * dependency circle for a check it already has the data to make.
   */
  @SubscribeMessage('subscribe:resource')
  async handleSubscribeResource(
    @MessageBody() data: { resourceId: string },
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const user = client.data.user as AuthenticatedUser | undefined;
    if (!(await this.mayFollowResource(data?.resourceId, user))) {
      this.logger.warn(
        `Client ${client.id} (user=${user?.userId}) refused resource ${data?.resourceId}`,
      );
      client.emit('subscription:refused', {
        resourceId: data?.resourceId,
        reason: 'not_found',
      });
      return;
    }

    const roomName = `resource:${data.resourceId}`;
    client.join(roomName);
    this.logger.log(
      `Client ${client.id} subscribed to resource ${data.resourceId}`,
    );
    client.emit('subscribed', { resourceId: data.resourceId, room: roomName });
  }

  private async mayFollowResource(
    resourceId: string | undefined,
    user: AuthenticatedUser | undefined,
  ): Promise<boolean> {
    if (!user || !resourceId) return false;
    if (user.isAdmin) return true;
    // One query: do you own an operation on this resource? If you do, the
    // shared rule says yes on the first branch. If you do not — or nothing has
    // happened to this resource yet — it falls through to the operator's
    // section level, which is the same second chance the route gives.
    const mine = await this.operations.findOne({
      where: { resourceId, userId: user.userId },
      select: { id: true, userId: true },
    });
    return mayReadOperation(this.policy, mine ?? { userId: null }, user);
  }

  @SubscribeMessage('unsubscribe:resource')
  handleUnsubscribeResource(
    @MessageBody() data: { resourceId: string },
    @ConnectedSocket() client: Socket,
  ): void {
    client.leave(`resource:${data.resourceId}`);
    client.emit('unsubscribed', { resourceId: data.resourceId });
  }

  emitProgress(
    operationId: string,
    resourceId: string,
    dto: InfrastructureOperationProgressDto,
  ): void {
    this.server
      .to(`operation:${operationId}`)
      .to(`resource:${resourceId}`)
      .emit('infrastructure:operation:progress', dto);
    this.logger.debug(
      `[${operationId}] progress: ${dto.percentage}% — ${dto.message}`,
    );
  }

  emitCompleted(
    operationId: string,
    resourceId: string,
    dto: InfrastructureOperationCompletedDto,
  ): void {
    this.server
      .to(`operation:${operationId}`)
      .to(`resource:${resourceId}`)
      .emit('infrastructure:operation:completed', dto);
    this.logger.log(
      `[${operationId}] completed (${dto.operationType}) in ${dto.duration}ms`,
    );
  }

  emitFailed(
    operationId: string,
    resourceId: string,
    dto: InfrastructureOperationFailedDto,
  ): void {
    this.server
      .to(`operation:${operationId}`)
      .to(`resource:${resourceId}`)
      .emit('infrastructure:operation:failed', dto);
    this.logger.error(
      `[${operationId}] failed (${dto.operationType}): ${dto.error}`,
    );
  }
}
