import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Configuration,
  FirewallsApi,
  FirewallActionsApi,
  ServersApi,
} from 'src/modules/providers/implementations/hetzner/generated';
import {
  IFirewallProvider,
  CreateFirewallConfig,
  FirewallCreationResult,
  FirewallDetails,
  FirewallRule,
  FirewallFilters,
} from '../interfaces/firewall-provider.interface';
import { ICredentialProvider } from '../interfaces/credential-provider.interface';
import { CloudProvider } from '../enums/cloud-provider.enum';
import { LabelService } from '../../common/services/label.service';
import axios, { AxiosInstance } from 'axios';
import * as https from 'node:https';

@Injectable()
export class HetznerFirewallService implements IFirewallProvider {
  private readonly logger = new Logger(HetznerFirewallService.name);
  private readonly basePath: string;
  private readonly timeout: number;

  constructor(
    private readonly configService: ConfigService,
    @Inject('ICredentialProvider')
    private readonly credentialProvider: ICredentialProvider,
    private readonly labelService: LabelService,
  ) {
    this.basePath = this.configService.get<string>(
      'HETZNER_API_BASE_PATH',
      'https://api.hetzner.cloud/v1',
    );
    this.timeout = Number.parseInt(
      this.configService.get<string>('HETZNER_TIMEOUT', '10000'),
      10,
    );
  }

  /**
   * Log-safe error summary: only the Hetzner API message/code and HTTP status.
   * Never serialize the raw AxiosError — its config carries the Bearer token.
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

  /**
   * Create custom Axios instance with optimized configuration
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
          `Hetzner Firewall API Request: ${config.method?.toUpperCase()} ${config.url}`,
        );
        return config;
      },
      (error) => {
        this.logger.error(
          `Hetzner Firewall API Request Error: ${this.describeError(error)}`,
        );
        return Promise.reject(error);
      },
    );

    // Response interceptor for logging
    instance.interceptors.response.use(
      (response) => {
        this.logger.debug(
          `Hetzner Firewall API Response: ${response.status} ${response.statusText}`,
        );
        return response;
      },
      (error) => {
        if (error.response) {
          this.logger.error(
            `Hetzner Firewall API Error Response: ${error.response.status} ${error.response.statusText}`,
          );
          this.logger.error(
            `Error Data: ${JSON.stringify(error.response.data, null, 2)}`,
          );
        } else if (error.request) {
          this.logger.error(
            `Hetzner Firewall API No Response Received - Possible network/timeout issue`,
          );
        } else {
          this.logger.error(`Hetzner Firewall API Error: ${error.message}`);
        }
        return Promise.reject(error);
      },
    );

    return instance;
  }

  /**
   * Create configured API client with proper headers
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
   * Create FirewallsApi instance with custom Axios configuration
   */
  private async createFirewallsApi(): Promise<FirewallsApi> {
    const configuration = await this.createConfiguration();
    const axiosInstance = this.createAxiosInstance();
    return new FirewallsApi(configuration, this.basePath, axiosInstance);
  }

  /**
   * Create FirewallActionsApi instance with custom Axios configuration
   */
  private async createFirewallActionsApi(): Promise<FirewallActionsApi> {
    const configuration = await this.createConfiguration();
    const axiosInstance = this.createAxiosInstance();
    return new FirewallActionsApi(configuration, this.basePath, axiosInstance);
  }

  /**
   * Create ServersApi instance with custom Axios configuration
   */
  private async createServersApi(): Promise<ServersApi> {
    const configuration = await this.createConfiguration();
    const axiosInstance = this.createAxiosInstance();
    return new ServersApi(configuration, this.basePath, axiosInstance);
  }

  async createFirewall(
    config: CreateFirewallConfig,
  ): Promise<FirewallCreationResult> {
    this.logger.log(`Creating firewall ${config.name}`);

    try {
      const firewallsApi = await this.createFirewallsApi();

      // Validate and transform rules to Hetzner API format
      const hetznerRules = this.validateAndTransformRules(config.rules);

      const createRequest: any = {
        name: config.name,
        labels: this.labelService.toRecord(config.labels),
        rules: hetznerRules,
      };

      // Apply to servers via label selector if provided
      if (config.applyToLabelSelector) {
        createRequest.apply_to = [
          {
            type: 'label_selector',
            label_selector: { selector: config.applyToLabelSelector },
          },
        ];
      } else if (
        config.applyToServerIds &&
        config.applyToServerIds.length > 0
      ) {
        createRequest.apply_to = config.applyToServerIds.map((id) => ({
          type: 'server',
          server: { id: Number.parseInt(id) },
        }));
      }

      this.logger.log(
        `Sending create firewall request to Hetzner API for ${config.name}`,
      );
      const response = await firewallsApi.createFirewall(createRequest);

      const result: FirewallCreationResult = {
        firewallId: response.data.firewall.id.toString(),
        appliedToServerIds: config.applyToServerIds,
      };

      this.logger.log(
        `Firewall ${config.name} created with ID ${response.data.firewall.id}`,
        result,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `Failed to create firewall ${config.name}: ${this.describeError(error)}`,
      );

      if (error.response?.data?.error) {
        const apiError = error.response.data.error;
        throw new Error(
          `Hetzner API Error: ${apiError.message} (${apiError.code})`,
        );
      }

      throw new Error(`Firewall creation failed: ${error.message}`);
    }
  }

  async updateFirewallRules(
    firewallId: string,
    rules: FirewallRule[],
  ): Promise<void> {
    this.logger.log(`Updating firewall ${firewallId} rules`);

    try {
      const actionsApi = await this.createFirewallActionsApi();

      // Validate and transform rules to Hetzner API format
      const hetznerRules = this.validateAndTransformRules(rules);

      await actionsApi.setFirewallRules(Number.parseInt(firewallId), {
        rules: hetznerRules,
      });

      this.logger.log(`Firewall ${firewallId} rules updated successfully`);
    } catch (error) {
      this.logger.error(
        `Failed to update firewall ${firewallId} rules: ${this.describeError(error)}`,
      );

      if (error.response?.data?.error) {
        const apiError = error.response.data.error;
        throw new Error(
          `Hetzner API Error: ${apiError.message} (${apiError.code})`,
        );
      }

      throw new Error(`Failed to update firewall rules: ${error.message}`);
    }
  }

  async getFirewall(firewallId: string): Promise<FirewallDetails | null> {
    try {
      const firewallsApi = await this.createFirewallsApi();
      const response = await firewallsApi.getFirewall(
        Number.parseInt(firewallId),
      );

      const firewall = response.data.firewall;
      return {
        id: firewall.id.toString(),
        name: firewall.name,
        rules: firewall.rules.map((rule) => ({
          description: rule.description || '',
          direction: rule.direction as 'in' | 'out',
          protocol: rule.protocol as 'tcp' | 'udp' | 'icmp',
          port: rule.port,
          sourceIps: rule.source_ips,
          destinationIps: rule.destination_ips,
        })),
        labels: firewall.labels || {},
        appliedTo: firewall.applied_to.map((resource) => ({
          serverId: resource.server?.id?.toString() || '',
          serverName: undefined, // Not available in API response
        })),
      };
    } catch (error) {
      if (error.response?.status === 404) {
        this.logger.warn(`Firewall ${firewallId} not found`);
        return null;
      }

      this.logger.error(
        `Failed to get firewall ${firewallId}: ${this.describeError(error)}`,
      );
      throw new Error(`Failed to get firewall: ${error.message}`);
    }
  }

  async listFirewalls(filters?: FirewallFilters): Promise<FirewallDetails[]> {
    try {
      const firewallsApi = await this.createFirewallsApi();

      let labelSelector: string | undefined;
      if (filters?.clusterId) {
        labelSelector = `flui-cluster-id=${filters.clusterId}`;
      } else if (filters?.labelSelector) {
        labelSelector = filters.labelSelector;
      }

      const response = await firewallsApi.listFirewalls(
        undefined,
        filters?.name,
        labelSelector,
      );

      return response.data.firewalls.map((firewall) => ({
        id: firewall.id.toString(),
        name: firewall.name,
        rules: firewall.rules.map((rule) => ({
          description: rule.description || '',
          direction: rule.direction as 'in' | 'out',
          protocol: rule.protocol as 'tcp' | 'udp' | 'icmp',
          port: rule.port,
          sourceIps: rule.source_ips,
          destinationIps: rule.destination_ips,
        })),
        labels: firewall.labels || {},
        appliedTo: firewall.applied_to.map((resource) => ({
          serverId: resource.server?.id?.toString() || '',
          serverName: undefined, // Not available in API response
        })),
      }));
    } catch (error) {
      this.logger.error(
        `Failed to list firewalls: ${this.describeError(error)}`,
      );
      return [];
    }
  }

  async deleteFirewall(firewallId: string): Promise<void> {
    this.logger.log(`Deleting firewall ${firewallId}`);

    try {
      const firewallsApi = await this.createFirewallsApi();
      await firewallsApi.deleteFirewall(Number.parseInt(firewallId));

      this.logger.log(`Firewall ${firewallId} deleted successfully`);
      return;
    } catch (error) {
      // Already deleted - success
      if (error.response?.status === 404) {
        this.logger.warn(`Firewall ${firewallId} not found, already deleted`);
        return;
      }

      // Resource in use - retry once after brief delay
      if (error.response?.data?.error?.code === 'resource_in_use') {
        const retryDelay = 3000; // 3 seconds
        this.logger.warn(
          `Firewall ${firewallId} is in use. Waiting ${retryDelay}ms before retry...`,
        );
        await this.sleep(retryDelay);

        // Single retry attempt
        try {
          const firewallsApi = await this.createFirewallsApi();
          await firewallsApi.deleteFirewall(Number.parseInt(firewallId));

          this.logger.log(
            `Firewall ${firewallId} deleted successfully on retry`,
          );
          return;
        } catch (retryError) {
          // Still in use after retry - throw meaningful error
          if (retryError.response?.data?.error?.code === 'resource_in_use') {
            throw new Error(
              `Firewall ${firewallId} is still in use. Servers may still be deleting or detaching. Please retry manually later.`,
            );
          }

          // Different error on retry - throw it
          this.logger.error(
            `Failed to delete firewall ${firewallId} on retry`,
            retryError,
          );
          if (retryError.response?.data?.error) {
            const apiError = retryError.response.data.error;
            throw new Error(
              `Hetzner API Error on retry: ${apiError.message} (${apiError.code})`,
            );
          }
          throw new Error(
            `Failed to delete firewall on retry: ${retryError.message}`,
          );
        }
      }

      // Other errors - log and throw immediately
      this.logger.error(
        `Failed to delete firewall ${firewallId}: ${this.describeError(error)}`,
      );

      if (error.response?.data?.error) {
        const apiError = error.response.data.error;
        throw new Error(
          `Hetzner API Error: ${apiError.message} (${apiError.code})`,
        );
      }

      throw new Error(`Failed to delete firewall: ${error.message}`);
    }
  }

  /**
   * Validate and transform firewall rules to Hetzner API format
   * Ensures required IP fields are present based on rule direction
   */
  private validateAndTransformRules(rules: FirewallRule[]): any[] {
    const defaultIps = ['0.0.0.0/0', '::/0']; // Allow from/to anywhere

    return rules.map((rule, index) => {
      // Validate inbound rules have sourceIps
      if (rule.direction === 'in') {
        if (!rule.sourceIps || rule.sourceIps.length === 0) {
          this.logger.warn(
            `Rule ${index + 1} ("${rule.description}"): Inbound rule missing sourceIps. Using default: ${defaultIps.join(', ')}`,
          );
        }
      }

      // Validate outbound rules have destinationIps
      if (rule.direction === 'out') {
        if (!rule.destinationIps || rule.destinationIps.length === 0) {
          this.logger.warn(
            `Rule ${index + 1} ("${rule.description}"): Outbound rule missing destinationIps. Using default: ${defaultIps.join(', ')}`,
          );
        }
      }

      let sourceIps: string[] | undefined;
      if (rule.direction === 'in') {
        sourceIps =
          rule.sourceIps && rule.sourceIps.length > 0
            ? rule.sourceIps
            : defaultIps;
      }
      let destinationIps: string[] | undefined;
      if (rule.direction === 'out') {
        destinationIps =
          rule.destinationIps && rule.destinationIps.length > 0
            ? rule.destinationIps
            : defaultIps;
      }
      // Transform to Hetzner format with safe defaults
      return {
        description: rule.description,
        direction: rule.direction,
        protocol: rule.protocol,
        port: rule.port || undefined,
        source_ips: sourceIps,
        destination_ips: destinationIps,
      };
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async getServerIdsByLabelSelector(labelSelector: string): Promise<string[]> {
    this.logger.log(`Finding servers with label selector: ${labelSelector}`);

    try {
      const serversApi = await this.createServersApi();
      const response = await serversApi.listServers(undefined, labelSelector);

      const servers = response.data.servers || [];
      const serverIds = servers.map((s) => s.id.toString());

      this.logger.log(
        `Found ${serverIds.length} server(s) matching label selector`,
      );

      return serverIds;
    } catch (error) {
      this.logger.error(
        `Failed to find servers with label selector ${labelSelector}`,
        error,
      );
      return [];
    }
  }

  async applyToServers(firewallId: string, serverIds: string[]): Promise<void> {
    this.logger.log(
      `Applying firewall ${firewallId} to ${serverIds.length} servers`,
    );

    try {
      const actionsApi = await this.createFirewallActionsApi();

      const resources = serverIds.map((id) => ({
        type: 'server' as const,
        server: { id: Number.parseInt(id) },
      }));

      //firewallsIdActionsApplyToResourcesPost
      await actionsApi.applyFirewallToResources(Number.parseInt(firewallId), {
        apply_to: resources,
      });

      this.logger.log(
        `Firewall ${firewallId} applied to ${serverIds.length} servers successfully`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to apply firewall ${firewallId}: ${this.describeError(error)}`,
      );

      if (error.response?.data?.error) {
        const apiError = error.response.data.error;
        throw new Error(
          `Hetzner API Error: ${apiError.message} (${apiError.code})`,
        );
      }

      throw new Error(`Failed to apply firewall: ${error.message}`);
    }
  }

  async removeFromServers(
    firewallId: string,
    serverIds: string[],
  ): Promise<void> {
    this.logger.log(
      `Removing firewall ${firewallId} from ${serverIds.length} servers`,
    );

    try {
      const actionsApi = await this.createFirewallActionsApi();

      const resources = serverIds.map((id) => ({
        type: 'server' as const,
        server: { id: Number.parseInt(id) },
      }));
      await actionsApi.removeFirewallFromResources(
        Number.parseInt(firewallId),
        {
          remove_from: resources,
        },
      );

      this.logger.log(
        `Firewall ${firewallId} removed from ${serverIds.length} servers successfully`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to remove firewall ${firewallId}: ${this.describeError(error)}`,
      );

      if (error.response?.data?.error) {
        const apiError = error.response.data.error;
        throw new Error(
          `Hetzner API Error: ${apiError.message} (${apiError.code})`,
        );
      }

      throw new Error(`Failed to remove firewall: ${error.message}`);
    }
  }

  async updateFirewallLabels(
    firewallId: string,
    labels: Record<string, string>,
    name?: string,
  ): Promise<void> {
    this.logger.log(`Updating firewall ${firewallId} labels`);

    try {
      const firewallsApi = await this.createFirewallsApi();

      await firewallsApi.updateFirewall(Number.parseInt(firewallId), {
        labels,
        ...(name ? { name } : {}),
      });

      this.logger.log(
        `Firewall ${firewallId} labels updated successfully: ${JSON.stringify(labels)}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to update firewall ${firewallId} labels`,
        error,
      );

      if (error.response?.data?.error) {
        const apiError = error.response.data.error;
        throw new Error(
          `Hetzner API Error: ${apiError.message} (${apiError.code})`,
        );
      }

      throw new Error(`Failed to update firewall labels: ${error.message}`);
    }
  }
}
