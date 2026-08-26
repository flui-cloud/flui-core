import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { BackoffOptions, Queue } from 'bull';
import { CreateServerDto } from '../dto/create-server.dto';
import { DeleteServerDto } from '../dto/delete-server.dto';
import { ServerResponseDto } from '../dto/server-response.dto';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
  CreateServerOperationMetadata,
  DeleteServerOperationMetadata,
} from '../entities/infrastructure-operations.entity';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { ProviderFactory } from 'src/modules/providers';
import { LabelService } from '../../../common/services/label.service';
import { getOperationSteps } from '../../operations/helpers/operation-steps.helper';
import { AccessService } from 'src/modules/access/services/access.service';
import * as crypto from 'node:crypto';
import { CAManagerService } from 'src/modules/access/services/ca-manager.service';
import { InfrastructureOperationsGateway } from '../../operations/gateway/infrastructure-operations.gateway';
import { CacheService } from 'src/modules/common/cache/cache.service';
import { ServerRef } from '../utils/provider-server-ref';

export interface CreateServerJobData {
  operationId: string;
  config: CreateServerDto;
  userId?: string;
}

export interface DeleteServerJobData {
  operationId: string;
  config: DeleteServerDto;
  userId?: string;
}

@Injectable()
export class ServersService {
  private readonly logger = new Logger(ServersService.name);

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    @InjectQueue('infrastructure') private readonly infrastructureQueue: Queue,
    private readonly providerFactory: ProviderFactory,
    private readonly labelService: LabelService,
    private readonly accessService: AccessService,
    private readonly caManager: CAManagerService,
    private readonly infraGateway: InfrastructureOperationsGateway,
    private readonly cacheService: CacheService,
  ) {}

  private async invalidateInstancesCache(): Promise<void> {
    try {
      await this.cacheService.deletePattern('instances:*');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to invalidate instances cache: ${msg}`);
    }
  }

  async listServers(clusterId?: string): Promise<ServerResponseDto[]> {
    const allServers: ServerResponseDto[] = [];
    const providers = this.getAvailableProviders();

    this.logger.debug(
      `Listing servers from all providers${
        clusterId ? ` for cluster ${clusterId}` : ''
      }`,
    );

    for (const provider of providers) {
      try {
        const providerService = this.providerFactory.getProvider(provider);
        let servers = await providerService.listServersAsDto();

        this.logger.debug(
          `Retrieved ${servers.length} servers from ${provider}`,
        );

        // Filter by cluster ID if provided
        if (clusterId) {
          servers = this.filterServersByClusterId(servers, clusterId);
          this.logger.debug(
            `After filtering ${provider}: ${servers.length} servers match cluster ${clusterId}`,
          );
        }

        allServers.push(...servers);
      } catch (error) {
        this.logger.warn(
          `Failed to list servers from ${provider}:`,
          error.message,
        );
      }
    }

    this.logger.debug(`Total servers returned: ${allServers.length}`);

    return allServers;
  }

  async getServersByProvider(
    provider: CloudProvider,
    clusterId?: string,
  ): Promise<ServerResponseDto[]> {
    try {
      this.logger.debug(
        `Getting servers from provider ${provider}${
          clusterId ? ` for cluster ${clusterId}` : ''
        }`,
      );

      const providerService = this.providerFactory.getProvider(provider);
      let servers = await providerService.listServersAsDto();

      this.logger.debug(`Retrieved ${servers.length} servers from ${provider}`);

      // Filter by cluster ID if provided
      if (clusterId) {
        this.logger.debug(
          `Applying cluster filter for cluster ID: ${clusterId}`,
        );
        servers = this.filterServersByClusterId(servers, clusterId);
        this.logger.debug(`After filtering: ${servers.length} servers remain`);
      }

      return servers;
    } catch (error) {
      this.logger.error(
        `Failed to list servers from ${provider}: ${error.message}`,
      );
      return [];
    }
  }

  async getServerById(
    serverId: string,
    provider: CloudProvider,
  ): Promise<ServerResponseDto> {
    const providerService = this.providerFactory.getProvider(provider);
    const server = await providerService.getServerDetailsAsDto(serverId);

    if (!server) {
      throw new NotFoundException(
        `Server ${serverId} not found in ${provider}`,
      );
    }

    return server;
  }

  async createServer(
    dto: CreateServerDto,
  ): Promise<InfrastructureOperationEntity> {
    this.logger.log(`Creating server: ${dto.name} on ${dto.provider}`);

    await this.validateCreateServerRequest(dto);
    dto.uuid = crypto.randomUUID();

    // user_data must be provided by the caller (typically from bootstrap-scripts repository)
    // The API no longer generates init scripts internally - they are managed externally
    if (dto.user_data) {
      this.logger.log('Using provided user_data script for server');
    } else {
      this.logger.warn(
        'No user_data provided for server creation. Server will be created without custom initialization.',
      );
    }

    // Generate operation steps
    const operationSteps = getOperationSteps(OperationType.CREATE_SERVER);

    const operation = this.operationRepository.create({
      operationType: OperationType.CREATE_SERVER,
      status: OperationStatus.PENDING,
      resourceType: 'server',
      resourceName: dto.name,
      provider: dto.provider,
      totalSteps: operationSteps.length,
      currentStepIndex: 0,
      currentStepProgress: 0,
      metadata: {
        serverConfig: dto,
        estimatedDurationInSeconds: 80, // 1 minute 20 seconds
        operationSteps, // Save steps for consistent progress tracking
      } as CreateServerOperationMetadata,
    });

    const savedOperation = await this.operationRepository.save(operation);

    const jobData: CreateServerJobData = {
      operationId: savedOperation.id,
      config: dto,
    };

    await this.infrastructureQueue.add('create-server', jobData, {
      attempts: 3,
      backoff: { type: 'exponential' } as BackoffOptions,
      delay: 1000,
    });

    this.logger.log(
      `Server creation queued with operation ID: ${savedOperation.id}`,
    );
    return savedOperation;
  }

  async deleteServer(
    dto: DeleteServerDto,
  ): Promise<InfrastructureOperationEntity> {
    this.logger.log(`Deleting server: ${dto.server_id} from ${dto.provider}`);

    await this.validateDeleteServerRequest(dto);

    const operation = this.operationRepository.create({
      operationType: OperationType.DELETE_SERVER,
      status: OperationStatus.PENDING,
      resourceType: 'server',
      resourceName: dto.server_id,
      provider: dto.provider,
      metadata: {
        serverConfig: dto,
        estimatedDurationInSeconds: 30, // 30 seconds
      } as DeleteServerOperationMetadata,
    });

    const savedOperation = await this.operationRepository.save(operation);

    const jobData: DeleteServerJobData = {
      operationId: savedOperation.id,
      config: dto,
    };

    await this.infrastructureQueue.add('delete-server', jobData, {
      attempts: 3,
      backoff: { type: 'exponential' } as BackoffOptions,
      delay: 1000,
    });

    this.logger.log(
      `Server deletion queued with operation ID: ${savedOperation.id}`,
    );
    return savedOperation;
  }

  async getOperationStatus(operationId: string): Promise<string> {
    const operation = await this.operationRepository.findOne({
      where: { id: operationId },
    });

    if (!operation) {
      throw new NotFoundException(`Operation ${operationId} not found`);
    }

    return operation.status;
  }

  async checkProvidersHealth(): Promise<{
    overall: string;
    providers: Array<{
      name: CloudProvider;
      status: string;
      responseTime?: number;
      error?: string;
    }>;
  }> {
    const providers = this.getAvailableProviders();
    const results = [];
    let allHealthy = true;

    for (const provider of providers) {
      const startTime = Date.now();
      try {
        const providerService = this.providerFactory.getProvider(provider);
        const healthCheck = await providerService.testConnection();
        const responseTime = Date.now() - startTime;

        results.push({
          name: provider,
          status: healthCheck.success ? 'healthy' : 'unhealthy',
          responseTime,
          error: healthCheck.error,
        });

        if (!healthCheck.success) {
          allHealthy = false;
        }
      } catch (error) {
        results.push({
          name: provider,
          status: 'error',
          responseTime: Date.now() - startTime,
          error: error.message,
        });
        allHealthy = false;
      }
    }

    return {
      overall: allHealthy ? 'healthy' : 'degraded',
      providers: results,
    };
  }

  async processCreateServer(jobData: CreateServerJobData): Promise<void> {
    const { operationId, config } = jobData;

    try {
      await this.updateOperationStatus(
        operationId,
        OperationStatus.IN_PROGRESS,
        {
          message: 'Starting server creation...',
          progress: 10,
        },
      );

      const providerService = this.providerFactory.getProvider(config.provider);

      // Check if server already exists (idempotency check for retries)
      const existingServers = await providerService.listServersAsDto();
      const existingServer = existingServers.find(
        (server) => server.name === config.name,
      );

      let result;
      if (existingServer) {
        this.logger.log(
          `Server ${config.name} already exists (ID: ${existingServer.id}), skipping creation`,
        );

        // Server already exists, use existing server details. Volumes are
        // re-resolved rather than skipped: the caller records their ids, and a
        // cluster that reports none leaks the paid Volume on delete.
        result = {
          serverId: existingServer.id,
          ipAddress:
            existingServer.public_ip || existingServer.private_ip || 'unknown',
          status: existingServer.status,
          actionId: undefined,
          attachedVolumes: await this.resolveExistingAttachedVolumes(
            providerService,
            existingServer.id,
            config.attachedVolumes,
          ),
        };

        await this.updateOperationStatus(
          operationId,
          OperationStatus.IN_PROGRESS,
          {
            message: 'Server already exists, waiting for startup...',
            progress: 70,
            serverId: result.serverId,
            ipAddress: result.ipAddress,
            idempotent: true,
          },
        );
      } else {
        // Resolve SSH keys to provider-specific IDs
        let providerSSHKeyIds: string[] = [];
        if (config.ssh_keys && config.ssh_keys.length > 0) {
          this.logger.log(
            `Syncing ${config.ssh_keys.length} SSH keys with ${config.provider}`,
          );
          const { infos, entities } =
            await this.accessService.getSSHKeysAsProviderInfo(
              config.ssh_keys,
              config.provider,
            );
          if (providerService.resolveSSHKeys) {
            providerSSHKeyIds = await providerService.resolveSSHKeys(infos);
            await this.accessService.saveSSHKeyProviderMappings(
              entities,
              providerSSHKeyIds,
              config.provider,
            );
          }
          this.logger.log(
            `SSH keys resolved. Provider IDs: ${providerSSHKeyIds.join(', ')}`,
          );
        }

        // Generate Flui labels for the server
        const labels = config.labels
          ? config.labels
          : this.labelService.generateServerLabels({
              resourceType: 'server',
              environment: config.environment,
            });

        const serverConfig = {
          name: config.name,
          server_type: config.server_type,
          image: config.image,
          location: config.location,
          ssh_keys: providerSSHKeyIds, // Use provider-specific SSH key IDs
          environment: config.environment,
          cluster_name: config.cluster_name,
          user_data: config.user_data,
          labels: labels,
          firewalls: config.firewalls,
          diskSizeGb: config.diskSizeGb,
          networks: config.networks,
          attachedVolumes: config.attachedVolumes,
        };

        result = await providerService.createServer(serverConfig);

        await this.updateOperationStatus(
          operationId,
          OperationStatus.IN_PROGRESS,
          {
            message: 'Server created, waiting for startup...',
            progress: 70,
            serverId: result.serverId,
            ipAddress: result.ipAddress,
            actionId: result.actionId,
            attachedVolumes: result.attachedVolumes,
          },
        );
      }

      await this.waitForServerReady(result.serverId, config.provider);

      // CA installation is now handled by cloud-init during server provisioning
      // No need for post-creation SSH enrollment
      this.logger.log(
        `Server ${result.serverId} provisioned. CA should be installed via cloud-init.`,
      );

      await this.updateOperationStatus(operationId, OperationStatus.COMPLETED, {
        message: 'Server created successfully',
        progress: 100,
        serverId: result.serverId,
        ipAddress: result.ipAddress,
        actionId: result.actionId,
        attachedVolumes: result.attachedVolumes,
      });

      await this.invalidateInstancesCache();

      this.logger.log(
        `Server creation completed: ${config.name} (${result.serverId})`,
      );
    } catch (error) {
      const errDetails = error.response?.data
        ? ` — ${JSON.stringify(error.response.data)}`
        : '';
      this.logger.error(
        `Server creation failed for ${config.name}: ${error.message}${errDetails}`,
      );
      await this.updateOperationStatus(operationId, OperationStatus.FAILED, {
        message: `Server creation failed: ${error.message}`,
        error: error.message,
      });
      throw error;
    }
  }

  async processDeleteServer(jobData: DeleteServerJobData): Promise<void> {
    const { operationId, config } = jobData;
    const resourceId = config.server_id;
    const startedAt = Date.now();

    try {
      await this.updateOperationStatus(
        operationId,
        OperationStatus.IN_PROGRESS,
        {
          message: 'Starting server deletion...',
          progress: 10,
        },
      );
      this.infraGateway.emitProgress(operationId, resourceId, {
        operationId,
        resourceId,
        operationType: OperationType.DELETE_SERVER,
        resourceType: 'server',
        percentage: 10,
        currentStepIndex: 0,
        totalSteps: 4,
        message: 'Starting server deletion...',
        timestamp: new Date(),
      });

      // Validate server ownership before deletion
      if (!config.force) {
        await this.validateServerOwnership(
          config.server_id,
          config.provider,
          'Cannot delete server not managed by Flui. Use force=true to override.',
        );
      }

      const providerService = this.providerFactory.getProvider(config.provider);
      const result = await providerService.deleteServer(config);

      await this.updateOperationStatus(
        operationId,
        OperationStatus.IN_PROGRESS,
        {
          message: 'Server deletion in progress...',
          progress: 80,
          actionId: result.actionId,
        },
      );
      this.infraGateway.emitProgress(operationId, resourceId, {
        operationId,
        resourceId,
        operationType: OperationType.DELETE_SERVER,
        resourceType: 'server',
        percentage: 80,
        currentStepIndex: 2,
        totalSteps: 4,
        message: 'Waiting for provider confirmation...',
        timestamp: new Date(),
      });

      await this.waitForDeletionComplete(
        config.server_id,
        config.provider,
        result.actionId,
      );

      await this.invalidateInstancesCache();

      await this.updateOperationStatus(operationId, OperationStatus.COMPLETED, {
        message: 'Server deleted successfully',
        progress: 100,
        actionId: result.actionId,
      });
      this.infraGateway.emitCompleted(operationId, resourceId, {
        operationId,
        resourceId,
        operationType: OperationType.DELETE_SERVER,
        resourceType: 'server',
        duration: Date.now() - startedAt,
        timestamp: new Date(),
      });

      this.logger.log(`Server deletion completed: ${config.server_id}`);
    } catch (error) {
      this.logger.error(
        `Server deletion failed for ${config.server_id}`,
        error,
      );
      await this.updateOperationStatus(operationId, OperationStatus.FAILED, {
        message: `Server deletion failed: ${error.message}`,
        error: error.message,
      });
      this.infraGateway.emitFailed(operationId, resourceId, {
        operationId,
        resourceId,
        operationType: OperationType.DELETE_SERVER,
        resourceType: 'server',
        error: error.message,
        timestamp: new Date(),
      });
      throw error;
    }
  }

  private async validateCreateServerRequest(
    dto: CreateServerDto,
  ): Promise<void> {
    if (!dto.name || dto.name.length < 3) {
      throw new BadRequestException(
        'Server name must be at least 3 characters long',
      );
    }

    if (dto.name.length > 63) {
      throw new BadRequestException(
        'Server name must be less than 64 characters',
      );
    }

    try {
      const providerService = this.providerFactory.getProvider(dto.provider);
      const existingServers = await providerService.listServersAsDto();
      const nameExists = existingServers.some(
        (server) => server.name === dto.name,
      );

      if (nameExists) {
        throw new BadRequestException(
          `Server with name '${dto.name}' already exists in ${dto.provider}`,
        );
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.warn(
        `Could not validate server name uniqueness: ${error.message}`,
      );
    }
  }

  private async validateDeleteServerRequest(
    dto: DeleteServerDto,
  ): Promise<void> {
    const providerService = this.providerFactory.getProvider(dto.provider);
    const server = await providerService.getServerDetailsAsDto(dto.server_id);

    if (!server) {
      throw new NotFoundException(
        `Server '${dto.server_id}' not found in ${dto.provider}`,
      );
    }

    this.logger.log(`Server ${dto.server_id} validated for deletion`);
  }

  /**
   * Validate that a server is managed by Flui before performing destructive operations
   * @throws ForbiddenException if server is not managed by Flui
   */
  async validateServerOwnership(
    serverId: string,
    provider: CloudProvider,
    errorMessage?: string,
  ): Promise<void> {
    const providerService = this.providerFactory.getProvider(provider);
    const server = await providerService.getServerDetailsAsDto(serverId);

    if (!server) {
      throw new NotFoundException(
        `Server ${serverId} not found in ${provider}`,
      );
    }

    // Check if server is managed by Flui
    const isManaged = this.labelService.isFluiManagedServer(server.labels);

    if (!isManaged) {
      const message =
        errorMessage ||
        `Server ${serverId} is not managed by Flui. Only Flui-managed servers can be deleted.`;
      this.logger.warn(
        `Attempted to delete non-Flui server: ${serverId} in ${provider}`,
      );
      throw new ForbiddenException(message);
    }

    this.logger.log(
      `Server ${serverId} validated as Flui-managed (labels: ${JSON.stringify(server.labels)})`,
    );
  }

  /**
   * Re-resolve the Volumes a previous attempt already created for this server.
   *
   * Two spellings of the same server meet here — the id Flui carries
   * (`instance:<zone>:<uuid>` on Scaleway) and the one the block API reports a
   * volume as attached to (the bare uuid) — so the question is asked through
   * {@link ServerRef}, which normalises both and never hands the strings back.
   *
   * What is *not* resolved is split in two, because the two are not equally
   * harmless:
   *
   * - A requested Volume that does not exist at all is a previous attempt that
   *   died before creating it. Nothing is leaking; the server comes up without
   *   the storage it asked for and that is logged.
   * - A Flui-managed Volume that carries the requested name but does not hang
   *   off this server is a disk that already exists and is already being paid
   *   for. Claiming it would be a guess, and recording nothing would leave it
   *   outside this cluster's billing and outside its destroy — an orphan. So
   *   the attempt is refused and the Volume is named.
   */
  private async resolveExistingAttachedVolumes(
    providerService: {
      listFluiManagedVolumes?: () => Promise<
        Array<{
          volumeId: string;
          name: string;
          sizeGb: number;
          attachedServerId?: string | null;
        }>
      >;
    },
    serverId: string,
    requested?: Array<{ name: string }>,
  ): Promise<Array<{ volumeId: string; sizeGb: number }> | undefined> {
    if (!requested?.length || !providerService.listFluiManagedVolumes) {
      return undefined;
    }

    const server = ServerRef.parse(serverId);
    if (!server) {
      throw new Error(
        `Cannot re-resolve Volumes for the existing server: its provider id ` +
          `is unreadable, so no Volume can be attributed to it without ` +
          `guessing. Refusing rather than leaving a paid disk unaccounted for.`,
      );
    }

    let volumes: Array<{
      volumeId: string;
      name: string;
      sizeGb: number;
      attachedServerId?: string | null;
    }>;
    try {
      volumes = await providerService.listFluiManagedVolumes();
    } catch (error) {
      this.logger.warn(
        `Could not resolve existing Volumes for server ${serverId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }

    const resolved: Array<{ volumeId: string; sizeGb: number }> = [];
    const strayNames: string[] = [];
    const missingNames: string[] = [];

    for (const req of requested) {
      const named = volumes.filter((v) => v.name === req.name);
      const mine = named.find((v) => server.ownsAttachment(v.attachedServerId));
      if (mine) {
        resolved.push({ volumeId: mine.volumeId, sizeGb: mine.sizeGb });
      } else if (named.length) {
        strayNames.push(req.name);
      } else {
        missingNames.push(req.name);
      }
    }

    if (strayNames.length) {
      throw new Error(
        `Server ${serverId} already existed, but ${strayNames.length} ` +
          `Flui-managed Volume(s) named ${strayNames.join(', ')} exist and are ` +
          `not attached to it. They are already being paid for; attributing ` +
          `them to this server would be a guess and ignoring them would leave ` +
          `them outside this cluster's billing and destroy. Detach or delete ` +
          `the stale Volume(s), then retry.`,
      );
    }

    if (missingNames.length) {
      this.logger.warn(
        `Server ${serverId} already existed but ${missingNames.length}/${requested.length} ` +
          `of its Volumes do not exist (${missingNames.join(', ')}) — a previous ` +
          `attempt died before creating them; the server comes up without them`,
      );
    }

    return resolved.length ? resolved : undefined;
  }

  private async waitForServerReady(
    serverId: string,
    provider: CloudProvider,
    maxWaitTime = 300000,
  ): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 10000;
    const providerService = this.providerFactory.getProvider(provider);

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const status = await providerService.getServerStatus(serverId);

        if (status === 'running') {
          this.logger.log(`Server ${serverId} is ready`);
          return;
        }

        if (status === 'error') {
          throw new Error('Server entered error state during startup');
        }

        this.logger.debug(`Server ${serverId} status: ${status}, waiting...`);
        await this.sleep(checkInterval);
      } catch (error) {
        this.logger.warn(`Error checking server status: ${error.message}`);
        await this.sleep(checkInterval);
      }
    }

    throw new Error(
      `Server ${serverId} did not become ready within ${maxWaitTime / 1000} seconds`,
    );
  }

  private async waitForDeletionComplete(
    serverId: string,
    provider: CloudProvider,
    actionId?: number,
    maxWaitTime = 300000,
  ): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 10000;
    const providerService = this.providerFactory.getProvider(provider);

    this.logger.log(
      `Waiting for server ${serverId} deletion to complete (action: ${actionId})`,
    );

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const status = await providerService.getServerStatus(serverId);

        if (status === 'not-found') {
          this.logger.log(`Server ${serverId} deletion completed`);
          return;
        }

        this.logger.debug(
          `Server ${serverId} still exists (status: ${status}), waiting...`,
        );
        await this.sleep(checkInterval);
      } catch (error) {
        this.logger.warn(
          `Error checking server deletion status: ${error.message}`,
        );
        await this.sleep(checkInterval);
      }
    }

    throw new Error(
      `Server ${serverId} deletion did not complete within ${maxWaitTime / 1000} seconds. Server may still exist on provider.`,
    );
  }

  /**
   * Check server status from provider
   * Returns 'not-found' if server is deleted (404)
   */
  async checkServerStatus(
    serverId: string,
    provider: CloudProvider,
  ): Promise<string> {
    const providerService = this.providerFactory.getProvider(provider);
    return await providerService.getServerStatus(serverId);
  }

  private async updateOperationStatus(
    operationId: string,
    status: OperationStatus,
    metadata: Record<string, any> = {},
  ): Promise<void> {
    const update: Partial<InfrastructureOperationEntity> = {
      status,
      metadata: { ...metadata },
      updatedAt: new Date(),
    };
    // Propagate error string to dedicated field so waitForOperation gets a real message
    if (status === OperationStatus.FAILED && metadata.error) {
      update.errorMessage = String(metadata.error);
    }
    if (status === OperationStatus.COMPLETED) {
      update.completedAt = new Date();
    }
    await this.operationRepository.update(operationId, update);
  }

  private getAvailableProviders(): CloudProvider[] {
    return this.providerFactory.getSupportedProviders();
  }

  private filterServersByClusterId(
    servers: ServerResponseDto[],
    clusterId: string,
  ): ServerResponseDto[] {
    this.logger.debug(
      `Filtering ${servers.length} servers for cluster ID: ${clusterId}`,
    );

    const filteredServers = servers.filter((server) => {
      // Check if server has labels
      if (
        !server.labels ||
        !Array.isArray(server.labels) ||
        server.labels.length === 0
      ) {
        this.logger.debug(`Server ${server.name} has no labels`);
        return false;
      }

      // Log all labels for debugging
      this.logger.debug(
        `Server ${server.name} labels:`,
        JSON.stringify(server.labels),
      );

      // Direct label access to avoid potential issues with labelService
      const serverClusterId = server.labels.find(
        (label) => label.key === 'flui-cluster-id',
      )?.value;

      const matches = serverClusterId === clusterId;
      this.logger.debug(
        `Server ${server.name}: cluster ID '${serverClusterId}' ${
          matches ? 'matches' : 'does not match'
        } '${clusterId}'`,
      );

      return matches;
    });

    this.logger.debug(
      `Filtered result: ${filteredServers.length} servers match cluster ID ${clusterId}`,
    );

    return filteredServers;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
