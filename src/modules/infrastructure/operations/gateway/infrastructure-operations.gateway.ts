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
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import {
  InfrastructureOperationProgressDto,
  InfrastructureOperationCompletedDto,
  InfrastructureOperationFailedDto,
} from '../dto/infrastructure-operation-events.dto';
import { WsAuthService } from '../../../auth/services/ws-auth.service';
import { installWsAuth } from '../../../auth/utils/ws-auth-middleware.util';
import { WS_CORS } from '../../../../config/cors-origin.config';

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

  constructor(private readonly wsAuth: WsAuthService) {}

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

  @SubscribeMessage('subscribe:operation')
  handleSubscribeOperation(
    @MessageBody() data: { operationId: string },
    @ConnectedSocket() client: Socket,
  ): void {
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

  @SubscribeMessage('subscribe:resource')
  handleSubscribeResource(
    @MessageBody() data: { resourceId: string },
    @ConnectedSocket() client: Socket,
  ): void {
    const roomName = `resource:${data.resourceId}`;
    client.join(roomName);
    this.logger.log(
      `Client ${client.id} subscribed to resource ${data.resourceId}`,
    );
    client.emit('subscribed', { resourceId: data.resourceId, room: roomName });
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
