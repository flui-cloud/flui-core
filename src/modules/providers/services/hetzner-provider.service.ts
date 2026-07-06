import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ICloudProvider,
  CreateServerConfig,
  ServerCreationResult,
  ServerDeletionResult,
  SSHKeyCreationResult,
  SSHKeyDetails,
  SshKeyInfo,
  AttachedVolumeResult,
  ChangeServerTypeConfig,
  ProviderVolumeSummary,
} from '../interfaces/cloud-provider.interface';
import { InstanceEntity } from '../../instances/entities/instance.entity';
import { ICredentialProvider } from '../interfaces/credential-provider.interface';
import { CloudProvider } from '../enums/cloud-provider.enum';
import axios, { AxiosInstance } from 'axios';
import * as https from 'node:https';
import {
  Configuration,
  ServersApi,
  CreateServerRequest,
  SSHKeysApi,
  ServerTypesApi,
  PricingApi,
  ServerActionsApi,
  DataCentersApi,
  ListServers200ResponseServersInner,
  ListServers200ResponseServersInnerStatusEnum,
  ListServerTypes200ResponseServerTypesInner,
  ActionsApi,
  Action,
  ActionStatusEnum,
  VolumesApi,
  VolumeActionsApi,
  CreateVolumeRequest,
} from 'src/modules/providers/implementations/hetzner/generated';
import { NodeSizeDto } from '../dto/node-size.dto';
import { PricingDto, PricingQueryDto } from '../dto/pricing.dto';
import { NodeSizeMapper } from '../mappers/node-size.mapper';
import { PricingMapper } from '../mappers/pricing.mapper';
import { InstanceStatus } from '../../instances/entities/instance-status.enum';
import { ServerResponseDto } from 'src/modules/infrastructure/servers/dto/server-response.dto';
import { DeleteServerDto } from 'src/modules/infrastructure/servers/dto/delete-server.dto';
import { SSHKeyDto } from 'src/modules/access/dto/ssh-key.dto';
import { LabelService } from '../../common/services/label.service';
import { HetznerNetworkService } from './hetzner-network.service';
import {
  CreateVNetConfig,
  VNetCreationResult,
  VNetDetails,
  VNetDeletionResult,
  AddSubnetConfig,
  DeleteSubnetConfig,
  AddRouteConfig,
  DeleteRouteConfig,
  AttachServerToVNetConfig,
  DetachServerFromVNetConfig,
  ServerVNetAttachmentResult,
  ChangeIpRangeConfig,
} from '../interfaces/network-provider.interface';

@Injectable()
export class HetznerProviderService implements ICloudProvider {
  private readonly logger = new Logger(HetznerProviderService.name);
  private readonly basePath: string;
  private readonly defaultUser: string;
  private readonly timeout: number;

  constructor(
    private readonly configService: ConfigService,
    @Inject('ICredentialProvider')
    private readonly credentialProvider: ICredentialProvider,
    private readonly nodeSizeMapper: NodeSizeMapper,
    private readonly pricingMapper: PricingMapper,
    private readonly labelService: LabelService,
  ) {
    this.basePath = this.configService.get<string>(
      'HETZNER_API_BASE_PATH',
      'https://api.hetzner.cloud/v1',
    );
    this.defaultUser = this.configService.get<string>(
      'HETZNER_DEFAULT_USER',
      'root',
    );
    this.timeout = Number.parseInt(
      this.configService.get<string>('HETZNER_TIMEOUT', '10000'),
      10,
    );
  }

  /**
   * Create a custom Axios instance with optimized configuration
   */
  private createAxiosInstance(): AxiosInstance {
    const httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: this.timeout,
      rejectUnauthorized: true,
      family: 4,
    });

    const instance = axios.create({
      timeout: this.timeout,
      httpsAgent,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Flui-Cloud-API/1.0',
        Connection: 'keep-alive',
      },
      validateStatus: (status) => status >= 200 && status < 300,
    });

    // Request interceptor for logging
    instance.interceptors.request.use(
      (config) => {
        this.logger.debug(
          `Hetzner API Request: ${config.method?.toUpperCase()} ${config.url}`,
        );
        // Headers intentionally not logged — they carry the API bearer token.
        return config;
      },
      (error) => {
        const errDetails = error.response?.data
          ? ` — ${JSON.stringify(error.response.data)}`
          : '';
        this.logger.error(
          `Hetzner API Request Error: ${error.message}${errDetails}`,
        );
        return Promise.reject(error);
      },
    );

    // Response interceptor for logging
    instance.interceptors.response.use(
      (response) => {
        this.logger.debug(
          `Hetzner API Response: ${response.status} ${response.statusText}`,
        );
        return response;
      },
      (error) => {
        if (error.response) {
          // Server responded with error status
          this.logger.error(
            `Hetzner API Error Response: ${error.response.status} ${error.response.statusText}`,
          );
          this.logger.error(
            `Error Data: ${JSON.stringify(error.response.data, null, 2)}`,
          );
        } else if (error.request) {
          // Request was made but no response received
          this.logger.error(
            `Hetzner API No Response Received - Possible network/timeout issue`,
          );
          this.logger.error(`Request URL: ${error.config?.url}`);
          this.logger.error(`Request Method: ${error.config?.method}`);
        } else {
          // Something else happened
          this.logger.error(`Hetzner API Error: ${error.message}`);
        }
        return Promise.reject(error);
      },
    );

    return instance;
  }

  /**
   * Create a configured API client with proper headers and custom Axios instance
   */
  private async createConfiguration(): Promise<Configuration> {
    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.HETZNER,
    );

    return new Configuration({
      accessToken: token,
      basePath: this.basePath,
      baseOptions: {
        headers: {
          'User-Agent': 'Flui-Cloud-API/1.0',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      },
    });
  }

  /**
   * Create ServersApi instance with custom Axios configuration
   */
  private async createServersApi(): Promise<ServersApi> {
    const configuration = await this.createConfiguration();
    const axiosInstance = this.createAxiosInstance();
    return new ServersApi(configuration, this.basePath, axiosInstance);
  }

  /**
   * Create SSHKeysApi instance with custom Axios configuration
   */
  private async createSSHKeysApi(): Promise<SSHKeysApi> {
    const configuration = await this.createConfiguration();
    const axiosInstance = this.createAxiosInstance();
    return new SSHKeysApi(configuration, this.basePath, axiosInstance);
  }

  /**
   * Create ServerTypesApi instance with custom Axios configuration
   */
  private async createServerTypesApi(): Promise<ServerTypesApi> {
    const configuration = await this.createConfiguration();
    const axiosInstance = this.createAxiosInstance();
    return new ServerTypesApi(configuration, this.basePath, axiosInstance);
  }

  /**
   * Create PricingApi instance with custom Axios configuration
   */
  private async createPricingApi(): Promise<PricingApi> {
    const configuration = await this.createConfiguration();
    const axiosInstance = this.createAxiosInstance();
    return new PricingApi(configuration, this.basePath, axiosInstance);
  }

  /**
   * Create VolumesApi instance with custom Axios configuration.
   * Used by §14 of the scaling architecture to provision Flui-managed
   * block storage Volumes attached to master nodes (NFS export backing).
   */
  private async createVolumesApi(): Promise<VolumesApi> {
    const configuration = await this.createConfiguration();
    const axiosInstance = this.createAxiosInstance();
    return new VolumesApi(configuration, this.basePath, axiosInstance);
  }

  private async createServerActionsApi(): Promise<ServerActionsApi> {
    const configuration = await this.createConfiguration();
    const axiosInstance = this.createAxiosInstance();
    return new ServerActionsApi(configuration, this.basePath, axiosInstance);
  }

  private async createVolumeActionsApi(): Promise<VolumeActionsApi> {
    const configuration = await this.createConfiguration();
    const axiosInstance = this.createAxiosInstance();
    return new VolumeActionsApi(configuration, this.basePath, axiosInstance);
  }

  private async createActionsApi(): Promise<ActionsApi> {
    const configuration = await this.createConfiguration();
    const axiosInstance = this.createAxiosInstance();
    return new ActionsApi(configuration, this.basePath, axiosInstance);
  }

  /**
   * Create DataCentersApi instance with custom Axios configuration
   */
  private async createDataCentersApi(): Promise<DataCentersApi> {
    const configuration = await this.createConfiguration();
    const axiosInstance = this.createAxiosInstance();
    return new DataCentersApi(configuration, this.basePath, axiosInstance);
  }

  async listInstances(filters?: any): Promise<InstanceEntity[]> {
    const serversApi = await this.createServersApi();

    // Build label selector if clusterId is provided
    let labelSelector: string | undefined;
    if (filters?.clusterId) {
      labelSelector = `flui-cluster-id=${filters.clusterId}`;
    }

    // Pass labelSelector to the Hetzner API call
    const response = await serversApi.listServers(undefined, labelSelector);

    return response.data.servers.map((server) => {
      return this.mapHetznerInstanceToEntity(server);
    });
  }

  async testApiKey(apiKey: string): Promise<boolean> {
    try {
      const configuration = new Configuration({
        accessToken: apiKey,
        basePath: this.basePath,
        baseOptions: {
          headers: {
            'User-Agent': 'Flui-Cloud-API/1.0',
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        },
      });

      const axiosInstance = this.createAxiosInstance();
      const serversApi = new ServersApi(
        configuration,
        this.basePath,
        axiosInstance,
      );
      await serversApi.listServers();

      return true;
    } catch (error) {
      if (error.response?.status === 401) {
        return false;
      }

      this.logger.error('Hetzner API key validation error:', error.message);
      return false;
    }
  }

  private mapHetznerInstanceToEntity(
    server: ListServers200ResponseServersInner,
  ): InstanceEntity {
    // Create a new instance of InstanceEntity
    const instance = new InstanceEntity();

    // Map basic fields
    instance.name = server.name;
    instance.displayName = server.name;
    instance.provider = CloudProvider.HETZNER;
    instance.providerId = server.id.toString();

    // Map status
    instance.status = this.mapHetznerStatus(server.status);

    // Map data center and region configuration. A just-created server may not
    // have these populated yet — tolerate missing fields instead of throwing
    // and voiding the whole instance list.
    instance.dataCenter = server.datacenter?.name ?? 'unknown';
    instance.region = server.datacenter?.location?.name ?? 'unknown';
    instance.regionName = server.datacenter?.location?.description ?? '';

    // Map hardware specifications
    instance.cpuCores = server.server_type?.cores ?? 0;
    instance.ramMb = (server.server_type?.memory ?? 0) * 1024; // Convert from GB to MB
    instance.diskMb = (server.primary_disk_size ?? 0) * 1024; // Convert from GB to MB

    // Operating system information
    instance.osType = server.image
      ? `${server.image.os_flavor} ${server.image.os_version}`
      : null;

    // IP configuration
    instance.ipConfig = {
      v4: server.public_net?.ipv4
        ? {
            ip: server.public_net.ipv4.ip,
            gateway: '', // Information not available in the response
            netmaskCidr: 32, // Standard IPv4
          }
        : undefined,
      v6: server.public_net?.ipv6
        ? {
            ip: server.public_net.ipv6.ip,
            gateway: '', // Information not available in the response
            netmaskCidr: 64, // Standard IPv6
          }
        : undefined,
    };

    // Additional information
    instance.productType = server.server_type?.name ?? 'unknown';
    instance.productName = server.server_type?.description ?? '';
    instance.defaultUser = this.defaultUser; // Default user for Hetzner servers

    // Additional IPs (floating IPs)
    instance.additionalIps =
      server.public_net?.floating_ips?.map((ip) => ip.toString()) || [];

    // Additional metadata that might be useful
    instance.metadata = {
      created: server.created,
      traffic: {
        outgoing: server.outgoing_traffic,
        ingoing: server.ingoing_traffic,
        included: server.included_traffic,
      },
      volumes: server.volumes,
      loadBalancers: server.load_balancers,
      labels: server.labels,
      locked: server.locked,
      rescueEnabled: server.rescue_enabled,
      placementGroup: server.placement_group,
    };

    return instance;
  }

  private mapHetznerStatus(
    status: ListServers200ResponseServersInnerStatusEnum,
  ): InstanceStatus {
    switch (status) {
      case ListServers200ResponseServersInnerStatusEnum.Running:
        return InstanceStatus.RUNNING;
      case ListServers200ResponseServersInnerStatusEnum.Off:
        return InstanceStatus.STOPPED;
      case ListServers200ResponseServersInnerStatusEnum.Starting:
        return InstanceStatus.STARTING;
      case ListServers200ResponseServersInnerStatusEnum.Initializing:
        return InstanceStatus.PROVISIONING;
      case ListServers200ResponseServersInnerStatusEnum.Stopping:
        return InstanceStatus.STOPPING;
      case ListServers200ResponseServersInnerStatusEnum.Deleting:
        return InstanceStatus.DELETING;
      case ListServers200ResponseServersInnerStatusEnum.Migrating:
        return InstanceStatus.MIGRATING;
      case ListServers200ResponseServersInnerStatusEnum.Rebuilding:
        return InstanceStatus.REBUILDING;
      case ListServers200ResponseServersInnerStatusEnum.Unknown:
      default:
        return InstanceStatus.UNKNOWN;
    }
  }

  // Server creation methods for infrastructure module
  async createServer(
    config: CreateServerConfig,
  ): Promise<ServerCreationResult> {
    this.logger.log(`Creating server ${config.name} via Hetzner API`);

    try {
      const serversApi = await this.createServersApi();

      // Map our config to Hetzner API request
      const createRequest: CreateServerRequest = {
        name: config.name,
        server_type: config.server_type || 'cx11',
        image: 'ubuntu-24.04',
        location: config.location || 'nbg1',
        start_after_create: true,
        ssh_keys: config.ssh_keys || [],
        user_data: config.user_data || '',
      };

      // Convert label array to Record for Hetzner API
      if (config.labels && config.labels.length > 0) {
        createRequest.labels = this.labelService.toRecord(config.labels);
      }

      // Attach firewalls if provided
      if (config.firewalls && config.firewalls.length > 0) {
        createRequest.firewalls = config.firewalls.map((id) => ({
          firewall: Number.parseInt(id, 10),
        }));
      }

      if (config.networks && config.networks.length > 0) {
        createRequest.networks = config.networks.map((id) =>
          Number.parseInt(id, 10),
        );
      }

      this.logger.log(
        `Sending create server request to Hetzner API for ${config.name}`,
      );
      const response = await serversApi.createServer(createRequest);

      const serverId = response.data.server.id;
      const result: ServerCreationResult = {
        serverId: serverId.toString(),
        ipAddress: response.data.server.public_net.ipv4?.ip,
        privateIp: response.data.server.private_net?.[0]?.ip,
        status: response.data.server.status,
        actionId: response.data.action.id,
      };

      // Provision Flui-managed Volumes if requested (§14 of scaling doc).
      // Each Volume is created with `server: <id>` so Hetzner attaches it
      // immediately, no separate attach action needed. We don't request
      // automount/format — the bootstrap script handles that idempotently.
      if (config.attachedVolumes && config.attachedVolumes.length > 0) {
        const attached: AttachedVolumeResult[] = [];
        const volumesApi = await this.createVolumesApi();
        for (const v of config.attachedVolumes) {
          // Hetzner Volume minimum is 10 GB.
          const sizeGb = Math.max(10, v.sizeGb);
          const volumeReq: CreateVolumeRequest = {
            name: v.name,
            size: sizeGb,
            server: serverId,
            ...(v.labels?.length
              ? { labels: this.labelService.toRecord(v.labels) }
              : {}),
          };
          this.logger.log(
            `Creating Hetzner Volume ${v.name} (${sizeGb} GB) for server ${serverId}`,
          );
          try {
            const volResp = await volumesApi.createVolume(volumeReq);
            const volumeId = volResp.data.volume.id;
            attached.push({
              volumeId: volumeId.toString(),
              // Hetzner Volume convention: /dev/disk/by-id/scsi-0HC_Volume_<id>
              devicePath: `/dev/disk/by-id/scsi-0HC_Volume_${volumeId}`,
              sizeGb,
            });
            this.logger.log(
              `Volume ${v.name} created and attached: id=${volumeId}`,
            );
          } catch (volErr: any) {
            this.logger.error(
              `Failed to create/attach Volume ${v.name} for server ${serverId}: ${volErr.message}`,
            );
            throw new Error(
              `Hetzner Volume creation failed for ${v.name}: ${volErr.message}`,
            );
          }
        }
        result.attachedVolumes = attached;
      }

      this.logger.log(`Server ${config.name} created successfully`, result);
      return result;
    } catch (error) {
      this.logger.error(
        `Failed to create server ${config.name}: ${this.describeError(error)}`,
      );

      // Handle Hetzner API specific errors
      if (error.response?.data?.error) {
        const apiError = error.response.data.error;
        throw new Error(
          `Hetzner API Error: ${apiError.message} (${apiError.code})`,
        );
      }

      throw new Error(`Server creation failed: ${error.message}`);
    }
  }

  /**
   * Concise, secret-free one-line description of a provider/axios error.
   * Never touches error.config/headers so the API token can't leak into logs.
   */
  private describeError(error: any): string {
    const api = error?.response?.data?.error;
    if (api?.message) {
      const code = api.code ? ` (${api.code})` : '';
      return api.message + code;
    }
    const status = error?.response?.status;
    const suffix = status ? ` [HTTP ${status}]` : '';
    return (error?.message ?? 'unknown error') + suffix;
  }

  async getServerStatus(serverId: string): Promise<string> {
    try {
      const serversApi = await this.createServersApi();
      const response = await serversApi.getServer(Number.parseInt(serverId));

      return response.data.server.status;
    } catch (error) {
      this.logger.warn(
        `Failed to get server status for ${serverId}: ${this.describeError(error)}`,
      );

      if (error.response?.status === 404) {
        return 'not-found';
      }

      return 'error';
    }
  }

  async getServerDetails(
    serverId: string,
  ): Promise<ListServers200ResponseServersInner | null> {
    try {
      const serversApi = await this.createServersApi();
      const response = await serversApi.getServer(Number.parseInt(serverId));

      return response.data.server;
    } catch (error) {
      this.logger.warn(
        `Failed to get server details for ${serverId}: ${this.describeError(error)}`,
      );
      return null;
    }
  }

  /**
   * Wait for an action to complete by monitoring its status
   * This is more efficient than polling server status as it uses Hetzner's action tracking system
   * @param actionId Action ID to wait for
   * @param timeoutMs Timeout in milliseconds (default: 5 minutes)
   * @param pollIntervalMs Polling interval in milliseconds (default: 3 seconds)
   * @returns Promise that resolves when action is complete
   * @throws Error if action fails or timeout is reached
   */
  async waitForActionCompletion(
    actionId: number,
    timeoutMs: number = 300000,
    pollIntervalMs: number = 3000,
  ): Promise<void> {
    const startTime = Date.now();
    const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs);

    this.logger.log(
      `Waiting for action ${actionId} to complete (timeout: ${timeoutMs}ms, poll interval: ${pollIntervalMs}ms)`,
    );

    const actionsApi = await this.createActionsApi();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await actionsApi.getAction(actionId);
        const action: Action = response.data.action;

        this.logger.debug(
          `Poll attempt ${attempt}/${maxAttempts}: Action ${actionId} status = ${action.status}, progress = ${action.progress}%`,
        );

        // Check if action completed successfully
        if (action.status === ActionStatusEnum.Success) {
          this.logger.log(
            `Action ${actionId} completed successfully (took ${Date.now() - startTime}ms)`,
          );
          return;
        }

        // Check if action failed
        if (action.status === ActionStatusEnum.Error) {
          const errorMsg =
            action.error?.message || 'Unknown error during action execution';
          throw new Error(`Action ${actionId} failed: ${errorMsg}`);
        }

        // Check timeout
        if (Date.now() - startTime >= timeoutMs) {
          throw new Error(
            `Timeout waiting for action ${actionId} to complete after ${timeoutMs}ms. Current status: ${action.status}, progress: ${action.progress}%`,
          );
        }

        // Wait before next poll (unless it's the last attempt)
        if (
          attempt < maxAttempts &&
          action.status === ActionStatusEnum.Running
        ) {
          await this.sleep(pollIntervalMs);
        }
      } catch (error) {
        // If we get a 404, the action might have been cleaned up (already completed)
        if (error.response?.status === 404) {
          this.logger.warn(
            `Action ${actionId} not found (might have been cleaned up). Assuming completion.`,
          );
          return;
        }
        throw error;
      }
    }

    throw new Error(
      `Failed to confirm action completion after ${maxAttempts} attempts`,
    );
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async deleteServer(config: DeleteServerDto): Promise<ServerDeletionResult> {
    this.logger.log(`Deleting server ${config.server_id} via Hetzner API`);

    try {
      const serversApi = await this.createServersApi();

      // First check if server exists and get its status
      const serverDetails = await this.getServerDetails(config.server_id);
      if (!serverDetails) {
        throw new Error(`Server ${config.server_id} not found`);
      }

      // Check if server is running and force is not set
      if (!config.force && serverDetails.status === 'running') {
        throw new Error(
          'Server is running. Use force=true to delete running servers.',
        );
      }

      this.logger.log(
        `Sending delete server request to Hetzner API for ${config.server_id}`,
      );
      const response = await serversApi.deleteServer(
        Number.parseInt(config.server_id),
      );

      const result: ServerDeletionResult = {
        actionId: response.data.action?.id,
        message: `Server ${config.server_id} deletion initiated`,
      };

      this.logger.log(
        `Server ${config.server_id} deletion initiated successfully`,
        result,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `Failed to delete server ${config.server_id}: ${this.describeError(error)}`,
      );

      // Handle Hetzner API specific errors
      if (error.response?.data?.error) {
        const apiError = error.response.data.error;
        throw new Error(
          `Hetzner API Error: ${apiError.message} (${apiError.code})`,
        );
      }

      // Handle 404 errors specially
      if (error.response?.status === 404) {
        throw new Error(`Server ${config.server_id} not found`);
      }

      throw new Error(`Server deletion failed: ${error.message}`);
    }
  }

  /**
   * Power off a server
   */
  async powerOffServer(serverId: string): Promise<void> {
    this.logger.log(`Powering off server ${serverId}`);

    try {
      const actionsApi = await this.createServerActionsApi();
      //serversIdActionsPoweroffPost
      await actionsApi.poweroffServer(Number.parseInt(serverId));
      this.logger.log(`Server ${serverId} poweroff action sent successfully`);
    } catch (error) {
      this.logger.error(
        `Failed to power off server ${serverId}: ${this.describeError(error)}`,
      );

      if (error.response?.data?.error) {
        const apiError = error.response.data.error;
        throw new Error(
          `Hetzner API Error: ${apiError.message} (${apiError.code})`,
        );
      }

      if (error.response?.status === 404) {
        throw new Error(`Server ${serverId} not found`);
      }

      throw new Error(`Server poweroff failed: ${error.message}`);
    }
  }

  /**
   * Power on a server
   */
  async powerOnServer(serverId: string): Promise<void> {
    this.logger.log(`Powering on server ${serverId}`);

    try {
      const actionsApi = await this.createServerActionsApi();
      await actionsApi.poweronServer(Number.parseInt(serverId));
      this.logger.log(`Server ${serverId} poweron action sent successfully`);
    } catch (error) {
      this.logger.error(
        `Failed to power on server ${serverId}: ${this.describeError(error)}`,
      );

      if (error.response?.data?.error) {
        const apiError = error.response.data.error;
        throw new Error(
          `Hetzner API Error: ${apiError.message} (${apiError.code})`,
        );
      }

      if (error.response?.status === 404) {
        throw new Error(`Server ${serverId} not found`);
      }

      throw new Error(`Server poweron failed: ${error.message}`);
    }
  }

  async changeServerType(
    serverId: string,
    config: ChangeServerTypeConfig,
  ): Promise<{ actionId?: number }> {
    this.logger.log(
      `Hetzner change_type server=${serverId} → ${config.targetServerType} (upgrade_disk=${config.upgradeDisk ?? false})`,
    );
    try {
      const actionsApi = await this.createServerActionsApi();
      const res = await actionsApi.changeServerType(Number.parseInt(serverId), {
        server_type: config.targetServerType,
        upgrade_disk: config.upgradeDisk ?? false,
      });
      return { actionId: res.data.action?.id };
    } catch (error) {
      const apiError = error.response?.data?.error;
      if (apiError) {
        throw new Error(
          `Hetzner change_type failed: ${apiError.message} (${apiError.code})`,
        );
      }
      if (error.response?.status === 404) {
        throw new Error(`Server ${serverId} not found`);
      }
      throw new Error(`Hetzner change_type failed: ${error.message}`);
    }
  }

  async expandVolume(
    volumeId: string,
    newSizeGb: number,
  ): Promise<{ actionId?: number }> {
    this.logger.log(`Hetzner resize volume=${volumeId} → ${newSizeGb} GB`);
    try {
      const volumeActionsApi = await this.createVolumeActionsApi();
      const res = await volumeActionsApi.resizeVolume(
        Number.parseInt(volumeId),
        { size: newSizeGb },
      );
      return { actionId: res.data.action?.id };
    } catch (error) {
      const apiError = error.response?.data?.error;
      if (apiError) {
        throw new Error(
          `Hetzner resize volume failed: ${apiError.message} (${apiError.code})`,
        );
      }
      if (error.response?.status === 404) {
        throw new Error(`Volume ${volumeId} not found`);
      }
      throw new Error(`Hetzner resize volume failed: ${error.message}`);
    }
  }

  async detachVolume(volumeId: string): Promise<{ actionId?: number }> {
    this.logger.log(`Hetzner detach volume=${volumeId}`);
    try {
      const volumeActionsApi = await this.createVolumeActionsApi();
      const res = await volumeActionsApi.detachVolume(
        Number.parseInt(volumeId),
      );
      return { actionId: res.data.action?.id };
    } catch (error) {
      const apiError = error.response?.data?.error;
      if (apiError?.code === 'locked') {
        this.logger.warn(
          `Hetzner volume ${volumeId} locked — likely already detaching`,
        );
        return {};
      }
      if (error.response?.status === 404) {
        this.logger.warn(
          `Hetzner volume ${volumeId} not found during detach — treating as success`,
        );
        return {};
      }
      throw new Error(`Hetzner detach volume failed: ${error.message}`);
    }
  }

  async deleteVolume(volumeId: string): Promise<void> {
    this.logger.log(`Hetzner delete volume=${volumeId}`);
    try {
      const volumesApi = await this.createVolumesApi();
      await volumesApi.deleteVolume(Number.parseInt(volumeId));
    } catch (error) {
      if (error.response?.status === 404) {
        this.logger.warn(`Hetzner volume ${volumeId} already gone`);
        return;
      }
      const apiError = error.response?.data?.error;
      if (apiError?.code === 'volume_already_attached') {
        throw new Error(
          `Volume ${volumeId} still attached — call detachVolume first`,
        );
      }
      throw new Error(`Hetzner delete volume failed: ${error.message}`);
    }
  }

  async listFluiManagedVolumes(): Promise<ProviderVolumeSummary[]> {
    try {
      const volumesApi = await this.createVolumesApi();
      const response = await volumesApi.listVolumes(
        undefined,
        undefined,
        undefined,
        'managed-by=flui-cloud',
      );
      return (response.data.volumes ?? []).map((v) => ({
        volumeId: String(v.id),
        name: v.name,
        sizeGb: v.size,
        region: v.location?.name,
        attachedServerId: v.server ? String(v.server) : null,
        labels: (v.labels as Record<string, string>) ?? {},
        createdAt: v.created,
      }));
    } catch (error) {
      this.logger.warn(
        `Hetzner listFluiManagedVolumes failed: ${error.message}`,
      );
      return [];
    }
  }

  async listServersAsDto(): Promise<ServerResponseDto[]> {
    try {
      const serversApi = await this.createServersApi();
      const response = await serversApi.listServers();

      return response.data.servers
        .map((server) => {
          try {
            return this.mapHetznerServerToDto(server);
          } catch (e) {
            this.logger.warn(
              `Skipping unmappable Hetzner server ${server?.id}: ${this.describeError(e)}`,
            );
            return null;
          }
        })
        .filter((s): s is ServerResponseDto => s !== null);
    } catch (error) {
      this.logger.error(
        `Failed to list servers from Hetzner API: ${this.describeError(error)}`,
      );
      return [];
    }
  }

  async getServerDetailsAsDto(
    serverId: string,
  ): Promise<ServerResponseDto | null> {
    try {
      const serverDetails = await this.getServerDetails(serverId);
      if (!serverDetails) {
        return null;
      }

      return this.mapHetznerServerToDto(serverDetails);
    } catch (error) {
      this.logger.warn(
        `Failed to get server details as DTO for ${serverId}: ${this.describeError(error)}`,
      );
      return null;
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const serversApi = await this.createServersApi();

      // Test with a simple API call
      await serversApi.listServers();

      return { success: true };
    } catch (error) {
      this.logger.error(
        `Hetzner API connection test failed: ${this.describeError(error)}`,
      );
      return {
        success: false,
        error: error.message,
      };
    }
  }

  private mapHetznerServerToDto(
    server: ListServers200ResponseServersInner,
  ): ServerResponseDto {
    // A freshly-created server may briefly lack datacenter/public_net while it
    // initializes; never let one incomplete record throw and void the whole list
    // (that silently breaks the create-idempotency check → duplicate-name 409s).
    return {
      id: server.id?.toString() ?? '',
      name: server.name,
      provider: CloudProvider.HETZNER,
      provider_resource_id: server.id?.toString() ?? '',
      server_type: server.server_type?.name ?? 'unknown',
      location: server.datacenter?.location?.name ?? 'unknown',
      status: server.status,
      public_ip: server.public_net?.ipv4?.ip || null,
      private_ip: server.private_net?.[0]?.ip || null,
      created_at: server.created ? new Date(server.created) : new Date(),
      updated_at: new Date(),
      lastSyncAt: new Date(),
      labels: this.labelService.fromRecord(server.labels || {}),
    };
  }

  async listSSHKeys(): Promise<SSHKeyDto[]> {
    try {
      const sshKeysApi = await this.createSSHKeysApi();
      const allKeys: SSHKeyDto[] = [];
      let page = 1;
      const perPage = 50; // Max allowed by Hetzner API

      // Fetch all pages
      while (true) {
        const response = await sshKeysApi.listSshKeys(
          undefined, // sort
          undefined, // name
          undefined, // fingerprint
          undefined, // labelSelector
          page,
          perPage,
        );

        const keys = response.data.ssh_keys
          .filter((sshKey) => this.isFluiManagedKey(sshKey.labels))
          .map((sshKey) => this.mapHetznerSSHKeyToDto(sshKey));

        allKeys.push(...keys);

        // Check if there are more pages
        const meta = response.data.meta;
        if (!meta?.pagination || page >= meta.pagination.last_page) {
          break;
        }

        page++;
      }

      this.logger.log(`Retrieved ${allKeys.length} SSH keys from Hetzner`);
      return allKeys;
    } catch (error) {
      this.logger.error(
        `Failed to list SSH keys from Hetzner API: ${this.describeError(error)}`,
      );
      return [];
    }
  }

  private mapHetznerSSHKeyToDto(sshKey: any): SSHKeyDto {
    return {
      id: sshKey.id.toString(),
      name: sshKey.name,
      publicKey: sshKey.public_key,
      fingerprint: sshKey.fingerprint,
      type: this.extractKeyType(sshKey.public_key),
      createdAt: new Date(sshKey.created),
      updatedAt: new Date(sshKey.created),
      source: CloudProvider.HETZNER,
      syncedFromProvider: true,
      providerKeyId: sshKey.id.toString(),
      isActive: sshKey.active || true, // Default to true if not specified
      lastUsed: sshKey.last_used ? new Date(sshKey.last_used) : undefined,
      autoGenerated: false,
      tags: sshKey.labels || {}, // Map Hetzner labels to tags
    };
  }

  private isFluiManagedKey(
    labels: Record<string, string> | null | undefined,
  ): boolean {
    if (!labels) return false;
    const isManagedByFlui = labels['managed-by'] === 'flui-cloud';
    const isLegacyFluiCli = labels['flui-cli'] === 'true';
    return isManagedByFlui || isLegacyFluiCli;
  }

  private extractKeyType(publicKey: string): string {
    if (publicKey.startsWith('ssh-rsa')) return 'rsa';
    if (publicKey.startsWith('ssh-ed25519')) return 'ed25519';
    if (publicKey.startsWith('ssh-dss')) return 'dsa';
    if (publicKey.startsWith('ecdsa-sha2')) return 'ecdsa';
    return 'unknown';
  }

  /**
   * Get available node sizes (server types) from Hetzner
   * Filters out ARM architecture servers
   * @param includeAvailability If true, includes real-time availability data from /datacenters endpoint (NOT cached)
   */
  async getNodeSizes(
    includeAvailability: boolean = true,
  ): Promise<NodeSizeDto[]> {
    this.logger.log(
      `Fetching node sizes from Hetzner API (includeAvailability: ${includeAvailability})`,
    );

    try {
      const serverTypesApi = await this.createServerTypesApi();
      const response = await serverTypesApi.listServerTypes();

      let nodeSizes = this.nodeSizeMapper.mapHetznerServerTypesToDtos(
        response.data.server_types,
      );

      // Filter out ARM architecture servers
      nodeSizes = nodeSizes.filter(
        (nodeSize) => nodeSize.architecture !== 'arm',
      );

      // If requested, enrich with real-time availability (NO CACHE)
      if (includeAvailability) {
        const availabilityMap = await this.getDatacenterAvailability();

        nodeSizes = nodeSizes.map((nodeSize) => {
          const serverTypeId = Number.parseInt(nodeSize.id);

          // Build availability info for each location this server type supports
          const availability = nodeSize.locations.map((loc) => ({
            location: loc.name,
            available:
              availabilityMap.get(loc.name)?.has(serverTypeId) ?? false,
            deprecated: !!loc.deprecation,
          }));

          return {
            ...nodeSize,
            availability,
          };
        });
      }

      // Sort by price (ascending, using first location's hourly gross price)
      const sortedNodeSizes = [...nodeSizes].sort((a, b) => {
        const priceA = a.prices[0]?.priceHourly?.gross;
        const priceB = b.prices[0]?.priceHourly?.gross;

        if (!priceA) return 1;
        if (!priceB) return -1;

        return Number.parseFloat(priceA) - Number.parseFloat(priceB);
      });

      this.logger.log(
        `Fetched ${response.data.server_types.length} node sizes, filtered to ${sortedNodeSizes.length} (excluding ARM), sorted by price`,
      );

      return sortedNodeSizes;
    } catch (error) {
      //error.errors for each concatenate message an log them
      this.logger.error(
        `Failed to fetch Hetzner node sizes: ${this.describeError(error)}`,
      );
      error?.errors?.forEach((err) => this.logger.error(err));
      throw new Error(`Failed to fetch node sizes`);
    }
  }

  /**
   * Get pricing information from Hetzner
   */
  async getPricing(query: PricingQueryDto): Promise<PricingDto> {
    this.logger.log('Fetching pricing from Hetzner API', query);

    try {
      const pricingApi = await this.createPricingApi();
      const response = await pricingApi.getPricing();

      return this.pricingMapper.mapHetznerPricingToDto(
        response.data.pricing,
        CloudProvider.HETZNER,
        query.region,
        query.nodeSize,
      );
    } catch (error) {
      this.logger.error(
        `Failed to fetch Hetzner pricing: ${this.describeError(error)}`,
      );
      throw new Error(`Failed to fetch pricing: ${error.message}`);
    }
  }

  /**
   * List raw server types with full pricing data including traffic pricing.
   * Used by billing service for cost calculations.
   */
  async listServerTypesRaw(): Promise<
    ListServerTypes200ResponseServerTypesInner[]
  > {
    const serverTypesApi = await this.createServerTypesApi();
    const response = await serverTypesApi.listServerTypes();
    return response.data.server_types;
  }

  /**
   * Get datacenter availability from Hetzner
   * Returns a map of location name to Set of available server type IDs
   */
  private async getDatacenterAvailability(): Promise<Map<string, Set<number>>> {
    this.logger.log('Fetching datacenter availability from Hetzner API');

    try {
      const datacenterApi = await this.createDataCentersApi();
      const response = await datacenterApi.listDatacenters();

      // Build a map: location name -> Set of available server type IDs
      const availabilityMap = new Map<string, Set<number>>();

      response.data.datacenters.forEach((dc) => {
        const locationName = dc.location.name;

        if (!availabilityMap.has(locationName)) {
          availabilityMap.set(locationName, new Set());
        }

        // Add all available server type IDs for this location
        dc.server_types.available.forEach((typeId) => {
          availabilityMap.get(locationName).add(typeId);
        });
      });

      this.logger.log(
        `Fetched availability for ${availabilityMap.size} locations from ${response.data.datacenters.length} datacenters`,
      );

      return availabilityMap;
    } catch (error) {
      this.logger.error(
        `Failed to fetch datacenter availability: ${this.describeError(error)}`,
      );
      throw new Error(
        `Failed to fetch datacenter availability: ${error.message}`,
      );
    }
  }

  /**
   * Create an SSH key on Hetzner
   */
  async createSSHKey(
    name: string,
    publicKey: string,
    labels?: Record<string, string>,
  ): Promise<SSHKeyCreationResult> {
    try {
      const sshKeysApi = await this.createSSHKeysApi();

      this.logger.log(
        `Creating SSH key ${name} on Hetzner with labels ${JSON.stringify(labels ?? {})}`,
      );

      const response = await sshKeysApi.createSshKey({
        name,
        public_key: publicKey,
        labels: labels || {},
      });

      this.logger.log(
        `SSH key ${name} created on Hetzner with ID ${response.data.ssh_key.id}`,
      );

      return {
        id: response.data.ssh_key.id.toString(),
        fingerprint: response.data.ssh_key.fingerprint,
      };
    } catch (error) {
      this.logger.error(
        `Failed to create SSH key ${name} on Hetzner: ${this.describeError(error)}`,
      );

      if (error.response?.status === 409) {
        throw new Error(`SSH key with name ${name} already exists on Hetzner`);
      }

      throw new Error(`Failed to create SSH key on Hetzner: ${error.message}`);
    }
  }

  /**
   * Delete an SSH key from Hetzner
   */
  async deleteSSHKey(providerKeyId: string): Promise<void> {
    try {
      const sshKeysApi = await this.createSSHKeysApi();

      this.logger.log(`Deleting SSH key ${providerKeyId} from Hetzner`);

      await sshKeysApi.deleteSshKey(Number.parseInt(providerKeyId, 10));

      this.logger.log(`SSH key ${providerKeyId} deleted from Hetzner`);
    } catch (error) {
      if (error.response?.status === 404) {
        this.logger.warn(
          `SSH key ${providerKeyId} not found on Hetzner, skipping deletion`,
        );
        return;
      }

      this.logger.error(
        `Failed to delete SSH key ${providerKeyId} from Hetzner: ${this.describeError(error)}`,
      );
      throw new Error(
        `Failed to delete SSH key from Hetzner: ${error.message}`,
      );
    }
  }

  /**
   * Get SSH key details from Hetzner
   */
  async getSSHKey(providerKeyId: string): Promise<SSHKeyDetails> {
    try {
      const sshKeysApi = await this.createSSHKeysApi();

      const response = await sshKeysApi.getSshKey(
        Number.parseInt(providerKeyId, 10),
      );

      return {
        id: response.data.ssh_key.id.toString(),
        name: response.data.ssh_key.name,
        publicKey: response.data.ssh_key.public_key,
        fingerprint: response.data.ssh_key.fingerprint,
        labels: response.data.ssh_key.labels,
      };
    } catch (error) {
      if (error.response?.status === 404) {
        throw new Error(`SSH key ${providerKeyId} not found on Hetzner`);
      }

      this.logger.error(
        `Failed to get SSH key ${providerKeyId} from Hetzner: ${this.describeError(error)}`,
      );
      throw new Error(`Failed to get SSH key from Hetzner: ${error.message}`);
    }
  }

  async resolveSSHKeys(keys: SshKeyInfo[]): Promise<string[]> {
    const providerIds: string[] = [];

    for (const key of keys) {
      // Return cached provider ID if already synced
      if (key.existingProviderId) {
        providerIds.push(key.existingProviderId);
        continue;
      }

      try {
        const result = await this.createSSHKey(key.name, key.publicKey);
        providerIds.push(result.id);
      } catch (error) {
        if (error.message?.includes('already exists')) {
          // Key exists — find it by fingerprint or name
          const existing = await this.listSSHKeys();
          const match = existing.find(
            (k) => k.fingerprint === key.fingerprint || k.name === key.name,
          );
          if (match) {
            providerIds.push(match.id);
            continue;
          }
        }
        throw error;
      }
    }

    return providerIds;
  }

  /**
   * Update server labels on Hetzner
   * IMPORTANT: This overwrites ALL labels, so we must merge with existing labels
   */
  async updateServerLabels(
    serverId: string,
    labels: Record<string, string>,
  ): Promise<void> {
    try {
      const serversApi = await this.createServersApi();

      this.logger.log(
        `Updating labels for server ${serverId}`,
        JSON.stringify(labels),
      );

      await serversApi.updateServer(Number.parseInt(serverId, 10), {
        labels: labels,
      });

      this.logger.log(`Server ${serverId} labels updated successfully`);
    } catch (error) {
      this.logger.error(
        `Failed to update labels for server ${serverId}: ${this.describeError(error)}`,
      );

      if (error.response?.status === 404) {
        throw new Error(`Server ${serverId} not found on Hetzner`);
      }

      if (error.response?.data?.error) {
        const apiError = error.response.data.error;
        throw new Error(
          `Hetzner API Error: ${apiError.message} (${apiError.code})`,
        );
      }

      throw new Error(`Failed to update server labels: ${error.message}`);
    }
  }

  // ==================== Network/VNet Management ====================

  /**
   * Get network service instance
   */
  private async getNetworkService(): Promise<HetznerNetworkService> {
    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.HETZNER,
    );
    return new HetznerNetworkService(token);
  }

  /**
   * Create a new VNet (private network)
   */
  async createVNet(config: CreateVNetConfig): Promise<VNetCreationResult> {
    const networkService = await this.getNetworkService();
    return networkService.createVNet(config);
  }

  /**
   * Delete a VNet
   */
  async deleteVNet(vnetId: string): Promise<VNetDeletionResult> {
    const networkService = await this.getNetworkService();
    return networkService.deleteVNet(vnetId);
  }

  /**
   * Get VNet details
   */
  async getVNet(vnetId: string): Promise<VNetDetails | null> {
    const networkService = await this.getNetworkService();
    return networkService.getVNet(vnetId);
  }

  /**
   * List all VNets
   */
  async listVNets(): Promise<VNetDetails[]> {
    const networkService = await this.getNetworkService();
    return networkService.listVNets();
  }

  /**
   * Add subnet to VNet
   */
  async addSubnet(config: AddSubnetConfig): Promise<{ actionId?: number }> {
    const networkService = await this.getNetworkService();
    return networkService.addSubnet(config);
  }

  /**
   * Delete subnet from VNet
   */
  async deleteSubnet(
    config: DeleteSubnetConfig,
  ): Promise<{ actionId?: number }> {
    const networkService = await this.getNetworkService();
    return networkService.deleteSubnet(config);
  }

  /**
   * Add route to VNet
   */
  async addRoute(config: AddRouteConfig): Promise<{ actionId?: number }> {
    const networkService = await this.getNetworkService();
    return networkService.addRoute(config);
  }

  /**
   * Delete route from VNet
   */
  async deleteRoute(config: DeleteRouteConfig): Promise<{ actionId?: number }> {
    const networkService = await this.getNetworkService();
    return networkService.deleteRoute(config);
  }

  /**
   * Change IP range of VNet (can only extend, not shrink)
   */
  async changeIpRange(
    config: ChangeIpRangeConfig,
  ): Promise<{ actionId?: number }> {
    const networkService = await this.getNetworkService();
    return networkService.changeIpRange(config);
  }

  /**
   * Attach server to VNet
   */
  async attachServerToVNet(
    config: AttachServerToVNetConfig,
  ): Promise<ServerVNetAttachmentResult> {
    try {
      const serverActionsApi = await this.createServerActionsApi();

      this.logger.log(
        `Attaching server ${config.serverId} to VNet ${config.vnetId}`,
      );

      const response = await serverActionsApi.attachServerToNetwork(
        Number.parseInt(config.serverId, 10),
        {
          network: Number.parseInt(config.vnetId, 10),
          ip: config.ip,
          alias_ips: config.aliasIps,
        },
      );

      const actionId = response.data.action?.id;

      this.logger.log(
        `Server ${config.serverId} attached to VNet ${config.vnetId}, action ID: ${actionId}`,
      );

      return {
        actionId,
        message: `Server attached to VNet successfully`,
      };
    } catch (error) {
      this.logger.error(
        `Failed to attach server ${config.serverId} to VNet ${config.vnetId}: ${error.message}`,
        error.stack,
      );
      throw new Error(
        `Failed to attach server to VNet on Hetzner: ${error.message}`,
      );
    }
  }

  /**
   * Detach server from VNet
   */
  async detachServerFromVNet(
    config: DetachServerFromVNetConfig,
  ): Promise<{ actionId?: number }> {
    try {
      const serverActionsApi = await this.createServerActionsApi();

      this.logger.log(
        `Detaching server ${config.serverId} from VNet ${config.vnetId}`,
      );

      const response = await serverActionsApi.detachServerFromNetwork(
        Number.parseInt(config.serverId, 10),
        {
          network: Number.parseInt(config.vnetId, 10),
        },
      );

      const actionId = response.data.action?.id;

      this.logger.log(
        `Server ${config.serverId} detached from VNet ${config.vnetId}, action ID: ${actionId}`,
      );

      return { actionId };
    } catch (error) {
      this.logger.error(
        `Failed to detach server ${config.serverId} from VNet ${config.vnetId}: ${error.message}`,
        error.stack,
      );
      throw new Error(
        `Failed to detach server from VNet on Hetzner: ${error.message}`,
      );
    }
  }
}
