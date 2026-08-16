import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { TerminalService } from '../services/terminal.service';
import {
  TERMINAL_DISABLED_MESSAGE,
  TerminalFeatureConfig,
} from '../terminal-feature.config';
import { WsAuthService } from '../../auth/services/ws-auth.service';
import { installWsAuth } from '../../auth/utils/ws-auth-middleware.util';

interface ConnectPayload {
  serverId: string;
  serverIp: string; // Changed from provider to serverIp to match Angular client
  tenantId?: string;
  rows?: number; // Terminal rows
  cols?: number; // Terminal columns
  /** Use bootstrap key auth instead of ephemeral certificate (fallback when CA is not yet configured) */
  useBootstrapKey?: boolean;
  /** Required when useBootstrapKey is true */
  clusterId?: string;
}

interface InputPayload {
  data: string;
}

interface ResizePayload {
  rows: number;
  cols: number;
}

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
export class TerminalGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(TerminalGateway.name);

  constructor(
    private readonly terminalService: TerminalService,
    private readonly wsAuth: WsAuthService,
    private readonly feature: TerminalFeatureConfig,
  ) {}

  afterInit(server: Server) {
    installWsAuth(server, this.wsAuth, this.logger);
    this.feature.noteDisabled();
    this.logger.log(
      `Terminal WebSocket Gateway initialized (auth enforced, terminal ${
        this.feature.enabled ? 'enabled' : 'disabled'
      })`,
    );
  }

  async handleConnection(socket: Socket) {
    // Refused at the door rather than deeper in: while the terminal is off the
    // SSH CA is not in the cluster at all, so there is nothing to sign with.
    if (!this.feature.enabled) {
      socket.emit('terminal:error', { message: TERMINAL_DISABLED_MESSAGE });
      socket.disconnect(true);
      return;
    }

    const user = socket.data.user;
    this.logger.log(
      `Terminal client connected: ${socket.id} (user=${user?.userId})`,
    );

    const tenantId = this.extractTenantId(socket);
    socket.data.tenantId = tenantId;

    socket.emit('terminal:ready', {
      socketId: socket.id,
      tenantId,
    });
  }

  async handleDisconnect(socket: Socket) {
    this.logger.log(`Terminal client disconnected: ${socket.id}`);

    try {
      await this.terminalService.closeConnection(socket.id);
    } catch (error) {
      this.logger.error(`Error closing connection: ${error.message}`);
    }
  }

  /**
   * Handle terminal connection request
   */
  @SubscribeMessage('terminal:connect')
  async handleConnect(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: ConnectPayload,
  ) {
    const { serverId, serverIp, rows, cols, useBootstrapKey, clusterId } =
      payload;
    const tenantId = payload.tenantId || socket.data.tenantId;

    this.logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.logger.log(`📥 Received terminal:connect event`);
    this.logger.log(`   Socket ID: ${socket.id}`);
    this.logger.log(`   Server ID: ${serverId}`);
    this.logger.log(`   Server IP: ${serverIp}`);
    this.logger.log(`   Tenant ID: ${tenantId || 'default'}`);
    this.logger.log(`   Terminal size: ${cols || 80}x${rows || 24}`);
    this.logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    try {
      // Generate unique session ID
      const sessionId = `session-${socket.id}-${Date.now()}`;

      this.logger.log(`🔐 Generating ephemeral certificate...`);

      // Create SSH connection with ephemeral certificate
      await this.terminalService.createConnection({
        socketId: socket.id,
        serverId,
        serverIp,
        tenantId,
        rows,
        cols,
        useBootstrapKey,
        clusterId,
        onData: (data: string) => {
          socket.emit('terminal:data', { data });
        },
        onError: (error: Error) => {
          this.logger.error(`❌ SSH Error: ${error.message}`);
          socket.emit('terminal:error', {
            message: error.message,
            code: 'SSH_ERROR',
          });
        },
        onClose: () => {
          this.logger.log(`🔌 SSH connection closed for ${serverId}`);
          socket.emit('terminal:disconnected', {
            serverId,
            reason: 'Connection closed',
            timestamp: new Date().toISOString(),
          });
        },
      });

      this.logger.log(`✅ SSH connection established successfully`);
      this.logger.log(
        `📤 Emitting terminal:connected event with sessionId: ${sessionId}`,
      );

      // Confirm connection - match Angular client expectations
      socket.emit('terminal:connected', {
        sessionId,
        serverId,
        serverIp,
        tenantId,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error(`❌ Failed to connect: ${error.message}`);
      this.logger.error(`   Stack: ${error.stack}`);

      socket.emit('terminal:error', {
        message: error.message || 'Failed to establish SSH connection',
        code: 'CONNECTION_FAILED',
        details: {
          serverId,
          serverIp,
        },
      });
    }
  }

  /**
   * Handle terminal input from client
   */
  @SubscribeMessage('terminal:input')
  async handleInput(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: InputPayload,
  ) {
    try {
      this.logger.debug(
        `📥 Received input (${payload.data.length} chars): ${JSON.stringify(payload.data.substring(0, 50))}`,
      );
      await this.terminalService.writeToConnection(socket.id, payload.data);
    } catch (error) {
      this.logger.error(`Failed to write input: ${error.message}`);
      socket.emit('terminal:error', {
        message: 'Failed to send input',
        code: 'INPUT_ERROR',
      });
    }
  }

  /**
   * Handle terminal resize
   */
  @SubscribeMessage('terminal:resize')
  async handleResize(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: ResizePayload,
  ) {
    try {
      await this.terminalService.resizeTerminal(
        socket.id,
        payload.rows,
        payload.cols,
      );
    } catch (error) {
      this.logger.error(`Failed to resize: ${error.message}`);
    }
  }

  /**
   * Handle disconnect request
   */
  @SubscribeMessage('terminal:disconnect')
  async handleTerminalDisconnect(@ConnectedSocket() socket: Socket) {
    try {
      await this.terminalService.closeConnection(socket.id);
      socket.emit('terminal:disconnected', {
        reason: 'User requested disconnect',
      });
    } catch (error) {
      this.logger.error(`Failed to disconnect: ${error.message}`);
    }
  }

  private extractTenantId(socket: Socket): string | undefined {
    const tenantId = socket.handshake.query.tenantId;
    if (tenantId && typeof tenantId === 'string') {
      return tenantId;
    }
    return undefined;
  }
}
