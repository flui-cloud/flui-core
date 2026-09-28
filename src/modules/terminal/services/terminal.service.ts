import { Injectable, Logger } from '@nestjs/common';
import { TerminalConnectionManager } from './terminal-connection-manager.service';
import { CertificateSignerService } from '../../access/services/certificate-signer.service';
import { NativeSSHConnectionService } from './native-ssh-connection.service';
import { AccessService } from '../../access/services/access.service';

export interface CreateConnectionOptions {
  socketId: string;
  serverId: string;
  serverIp: string; // Direct IP instead of provider lookup
  tenantId?: string;
  rows?: number; // Terminal rows
  cols?: number; // Terminal columns
  /** Use bootstrap key auth instead of ephemeral certificate (fallback when CA is not yet configured) */
  useBootstrapKey?: boolean;
  /** Required when useBootstrapKey is true — used to retrieve the cluster's bootstrap private key */
  clusterId?: string;
  /** Who opens the shell, for the record of the certificate issued to it. */
  requestedBy?: { userId?: string; email?: string };
  onData: (data: string) => void;
  onError: (error: Error) => void;
  onClose: () => void;
}

@Injectable()
export class TerminalService {
  private readonly logger = new Logger(TerminalService.name);

  constructor(
    private readonly connectionManager: TerminalConnectionManager,
    private readonly certificateSigner: CertificateSignerService,
    private readonly nativeSsh: NativeSSHConnectionService,
    private readonly accessService: AccessService,
  ) {}

  /**
   * Create SSH connection with ephemeral certificate using native SSH
   */
  async createConnection(options: CreateConnectionOptions): Promise<void> {
    const {
      socketId,
      serverId,
      serverIp,
      tenantId,
      rows,
      cols,
      useBootstrapKey,
      clusterId,
      requestedBy,
      onData,
      onError,
      onClose,
    } = options;

    this.logger.log(`🚀 Creating SSH connection for socket ${socketId}`);
    this.logger.log(`   Server ID: ${serverId}`);
    this.logger.log(`   Server IP: ${serverIp}`);
    this.logger.log(`   Tenant: ${tenantId || 'default'}`);
    this.logger.log(`   Terminal size: ${cols || 80}x${rows || 24}`);
    this.logger.log(
      `   Auth mode: ${useBootstrapKey ? 'bootstrap-key' : 'ephemeral-certificate'}`,
    );

    try {
      // Check if connection already exists
      if (this.connectionManager.hasConnection(socketId)) {
        throw new Error('Connection already exists for this socket');
      }

      // 1. Resolve credentials based on auth mode
      let credentials: { privateKey: string; certificate?: string };

      if (useBootstrapKey && clusterId) {
        this.logger.warn(
          `⚠️  Bootstrap key auth for cluster ${clusterId} — CA may not be configured yet on this server`,
        );
        const privateKey =
          await this.accessService.getBootstrapPrivateKeyForCluster(clusterId);
        credentials = { privateKey };
        this.logger.log(
          `✅ Bootstrap private key retrieved for cluster ${clusterId}`,
        );
      } else {
        this.logger.log(
          `🔐 Generating ephemeral certificate for tenant ${tenantId || 'default'}...`,
        );
        const cert = await this.certificateSigner.generateEphemeralCertificate(
          tenantId,
          1800,
          {
            purpose: 'terminal',
            target: serverIp,
            userId: requestedBy?.userId,
            email: requestedBy?.email,
          },
        );
        credentials = {
          privateKey: cert.privateKey,
          certificate: cert.certificate,
        };
        this.logger.log(`✅ Ephemeral certificate generated successfully`);
      }

      // 2. Validate server IP
      if (!serverIp || serverIp.trim() === '') {
        throw new Error('Server IP is required');
      }

      this.logger.log(`✅ Using server IP: ${serverIp}`);

      // 3. Create native SSH connection
      this.logger.log(`🔑 Creating native SSH connection...`);

      const sshConnection = await this.nativeSsh.createConnection(
        serverIp,
        'root',
        credentials,
        onData,
        onError,
        onClose,
        {
          rows,
          cols,
        },
      );

      this.logger.log(
        `✅ SSH connection established to ${serverIp} for socket ${socketId}`,
      );

      // Store connection
      this.connectionManager.addConnection(socketId, {
        process: sshConnection.process,
        serverId,
        serverIp,
        tenantId,
        createdAt: new Date(),
        cleanup: sshConnection.cleanup,
      });

      this.logger.log(`✅ Connection stored for socket ${socketId}`);
    } catch (error) {
      this.logger.error(
        `Failed to create connection for ${socketId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Write data to terminal
   */
  async writeToConnection(socketId: string, data: string): Promise<void> {
    const connection = this.connectionManager.getConnection(socketId);
    if (!connection) {
      throw new Error(`No connection found for socket ${socketId}`);
    }

    try {
      this.nativeSsh.writeData(connection.process, data);
    } catch (error) {
      throw new Error(`Failed to write data: ${error.message}`);
    }
  }

  /**
   * Resize terminal window
   * Note: Native SSH doesn't support dynamic resizing easily
   */
  async resizeTerminal(
    socketId: string,
    rows: number,
    cols: number,
  ): Promise<void> {
    const connection = this.connectionManager.getConnection(socketId);
    if (!connection) {
      this.logger.warn(`No connection found for resize: ${socketId}`);
      return;
    }

    // Native SSH doesn't support dynamic PTY resizing
    this.nativeSsh.resizeTerminal(connection.process, rows, cols);
  }

  /**
   * Close SSH connection
   */
  async closeConnection(socketId: string): Promise<void> {
    const connection = this.connectionManager.getConnection(socketId);
    if (connection) {
      this.logger.log(`Closing connection for socket ${socketId}`);
      await this.connectionManager.removeConnection(socketId);
    }
  }

  /**
   * Get connection stats
   */
  getConnectionStats() {
    return this.connectionManager.getStats();
  }
}
