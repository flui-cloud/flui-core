import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import {
  Configuration,
  InstancesApi,
  InstanceTypesApi,
  PrivateNICsApi,
  CreatePrivateNICZoneEnum,
  ScalewayInstanceV1PrivateNIC,
  ScalewayInstanceV1SecurityGroupRule,
  ListSecurityGroupRulesZoneEnum,
  SecurityGroupsApi,
  CreateServerRequest,
  ServerActionRequest,
  ServerActionRequestActionEnum,
  UpdateServerRequest,
  CreateSecurityGroupRequest,
  SetSecurityGroupRulesRequest,
  ScalewayInstanceV1Server,
  ScalewayInstanceV1SecurityGroup,
  ScalewayInstanceV1SetSecurityGroupRulesRequestRule,
  ScalewayInstanceV1ListServersTypesResponseServersServerKey,
  ScalewayInstanceV1SecurityGroupTemplate,
  CreateServerZoneEnum,
  GetServerZoneEnum,
  ServerActionZoneEnum,
  UpdateServerZoneEnum,
  ListServersZoneEnum,
  ListServersTypesZoneEnum,
  CreateSecurityGroupZoneEnum,
  GetSecurityGroupZoneEnum,
  ListSecurityGroupsZoneEnum,
  SetSecurityGroupRulesZoneEnum,
  DeleteSecurityGroupZoneEnum,
} from './generated/instances';

export const INSTANCE_ZONES: CreateServerZoneEnum[] = [
  CreateServerZoneEnum.FrPar1,
  CreateServerZoneEnum.FrPar2,
  CreateServerZoneEnum.FrPar3,
  CreateServerZoneEnum.NlAms1,
  CreateServerZoneEnum.NlAms2,
  CreateServerZoneEnum.NlAms3,
  CreateServerZoneEnum.PlWaw1,
  CreateServerZoneEnum.PlWaw2,
  CreateServerZoneEnum.PlWaw3,
];

export interface ScalewayInstanceServerType
  extends ScalewayInstanceV1ListServersTypesResponseServersServerKey {
  name?: string;
}

@Injectable()
export class ScalewayInstancesAdapter {
  private readonly logger = new Logger(ScalewayInstancesAdapter.name);
  private readonly baseUrl = 'https://api.scaleway.com';
  private readonly timeout = 15000;

  private createAxiosInstance(): AxiosInstance {
    return axios.create({
      timeout: this.timeout,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Flui-Cloud-API/1.0',
      },
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  private createConfiguration(token: string): Configuration {
    return new Configuration({
      basePath: this.baseUrl,
      baseOptions: {
        headers: {
          'X-Auth-Token': token,
          'User-Agent': 'Flui-Cloud-API/1.0',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      },
    });
  }

  private createInstancesApi(token: string): InstancesApi {
    return new InstancesApi(
      this.createConfiguration(token),
      this.baseUrl,
      this.createAxiosInstance(),
    );
  }

  private createInstanceTypesApi(token: string): InstanceTypesApi {
    return new InstanceTypesApi(
      this.createConfiguration(token),
      this.baseUrl,
      this.createAxiosInstance(),
    );
  }

  private createSecurityGroupsApi(token: string): SecurityGroupsApi {
    return new SecurityGroupsApi(
      this.createConfiguration(token),
      this.baseUrl,
      this.createAxiosInstance(),
    );
  }

  private createPrivateNicsApi(token: string): PrivateNICsApi {
    return new PrivateNICsApi(
      this.createConfiguration(token),
      this.baseUrl,
      this.createAxiosInstance(),
    );
  }

  /**
   * Resolve a Scaleway IPAM IP UUID to its inline address (e.g. "10.10.1.3").
   * IPv6 addresses are filtered out — callers want the v4 used by K3s join.
   */
  async resolveIpamIpv4(
    token: string,
    region: string,
    ipId: string,
  ): Promise<string | null> {
    const url = `${this.baseUrl}/ipam/v1/regions/${region}/ips/${ipId}`;
    try {
      const resp = await this.createAxiosInstance().get(url, {
        headers: { 'X-Auth-Token': token },
      });
      const data = resp.data as { address?: string; is_ipv6?: boolean };
      if (!data?.address || data.is_ipv6) return null;
      // Scaleway returns "10.10.1.3/24" — strip prefix length.
      return data.address.split('/')[0];
    } catch (err) {
      this.logger.warn(
        `[Scaleway] IPAM lookup ${ipId} failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Resolve the IPv4 address of the first NIC attached to a Private Network.
   * Returns null if the server has no NIC or IPAM hasn't allocated an IPv4 yet.
   */
  async getInstancePrivateIp(
    token: string,
    zone: CreateServerZoneEnum,
    server: ScalewayInstanceV1Server,
  ): Promise<string | null> {
    const nics = (server as any).private_nics ?? [];
    if (nics.length === 0) return null;
    const region = (zone as string).replace(/-\d+$/, '');
    for (const nic of nics) {
      const inline = nic.private_ip;
      if (inline) return String(inline);
      const ipIds: string[] = nic.ipam_ip_ids ?? [];
      for (const ipId of ipIds) {
        const ipv4 = await this.resolveIpamIpv4(token, region, ipId);
        if (ipv4) return ipv4;
      }
    }
    return null;
  }

  /**
   * Attach a Scaleway Instance to a Private Network by creating a Private NIC.
   * Idempotent: returns the existing NIC if one already attaches the server to
   * the same private network.
   */
  async attachToPrivateNetwork(
    token: string,
    zone: CreateServerZoneEnum,
    serverId: string,
    privateNetworkId: string,
  ): Promise<ScalewayInstanceV1PrivateNIC> {
    const api = this.createPrivateNicsApi(token);
    const list = await api.listPrivateNICs(
      zone as unknown as CreatePrivateNICZoneEnum,
      serverId,
    );
    const existing = (list.data?.private_nics ?? []).find(
      (n) => n.private_network_id === privateNetworkId,
    );
    if (existing) {
      this.logger.log(
        `[Scaleway] Server ${serverId} already attached to private network ${privateNetworkId} (NIC ${existing.id})`,
      );
      return existing;
    }
    const resp = await api.createPrivateNIC(
      zone as unknown as CreatePrivateNICZoneEnum,
      serverId,
      { private_network_id: privateNetworkId },
    );
    const nic = resp.data?.private_nic;
    if (!nic) {
      throw new Error(
        `createPrivateNIC for server ${serverId} returned no NIC payload`,
      );
    }
    this.logger.log(
      `[Scaleway] Attached server ${serverId} to private network ${privateNetworkId} (NIC ${nic.id})`,
    );
    return nic;
  }

  // ─── Server methods ────────────────────────────────────────────────────────

  async listServers(
    token: string,
    zone: CreateServerZoneEnum,
  ): Promise<ScalewayInstanceV1Server[]> {
    const api = this.createInstancesApi(token);
    const allServers: ScalewayInstanceV1Server[] = [];
    let page = 1;
    const perPage = 50;

    while (true) {
      const response = await api.listServers(
        zone as unknown as ListServersZoneEnum,
        perPage,
        page,
      );
      const servers = response.data.servers || [];
      allServers.push(...servers);

      const totalCount = Number.parseInt(
        response.headers?.['x-total-count'] || '0',
        10,
      );
      if (allServers.length >= totalCount || servers.length < perPage) {
        break;
      }
      page++;
    }

    return allServers;
  }

  async getServer(
    token: string,
    zone: string,
    serverId: string,
  ): Promise<ScalewayInstanceV1Server | null> {
    const api = this.createInstancesApi(token);
    const response = await api.getServer(
      zone as unknown as GetServerZoneEnum,
      serverId,
    );
    return response.data.server || null;
  }

  async createServer(
    token: string,
    zone: CreateServerZoneEnum,
    payload: CreateServerRequest,
  ): Promise<ScalewayInstanceV1Server> {
    const api = this.createInstancesApi(token);
    const response = await api.createServer(zone, payload);
    return response.data.server;
  }

  async deleteServer(
    token: string,
    zone: string,
    serverId: string,
  ): Promise<void> {
    // Scaleway instances must be terminated via the 'terminate' action, not the DELETE API.
    // The DELETE API returns 400 if the server is not in 'stopped' state.
    // The 'terminate' action works from any state (running, stopped, etc.) and also deallocates volumes.
    await this.serverAction(
      token,
      zone,
      serverId,
      ServerActionRequestActionEnum.Terminate,
    );
  }

  async serverAction(
    token: string,
    zone: string,
    serverId: string,
    action: ServerActionRequestActionEnum,
  ): Promise<void> {
    const api = this.createInstancesApi(token);
    const request: ServerActionRequest = { action };
    await api.serverAction(
      zone as unknown as ServerActionZoneEnum,
      serverId,
      request,
    );
  }

  async updateServerTags(
    token: string,
    zone: string,
    serverId: string,
    tags: string[],
  ): Promise<void> {
    const api = this.createInstancesApi(token);
    const request: UpdateServerRequest = { tags };
    await api.updateServer(
      zone as unknown as UpdateServerZoneEnum,
      serverId,
      request,
    );
  }

  /**
   * Change the commercial_type of a stopped Instance. Scaleway constraints:
   * - server must be in `stopped` state
   * - cannot be in a placement group
   * - cross-OS family (Linux↔Windows) not allowed
   * - local-storage requirements of the target type must be satisfied
   *
   * The caller is responsible for stopping the server beforehand and for
   * starting it after. Returns when the API accepts the request; the change
   * is applied during the next power-on.
   */
  async updateServerCommercialType(
    token: string,
    zone: string,
    serverId: string,
    commercialType: string,
  ): Promise<void> {
    const api = this.createInstancesApi(token);
    const request: UpdateServerRequest = { commercial_type: commercialType };
    await api.updateServer(
      zone as unknown as UpdateServerZoneEnum,
      serverId,
      request,
    );
  }

  async listServerTypes(
    token: string,
    zone: CreateServerZoneEnum,
  ): Promise<Array<ScalewayInstanceServerType & { name: string }>> {
    const api = this.createInstanceTypesApi(token);
    const response = await api.listServersTypes(
      zone as unknown as ListServersTypesZoneEnum,
    );
    const serversMap = response.data.servers as
      | Record<
          string,
          ScalewayInstanceV1ListServersTypesResponseServersServerKey
        >
      | undefined;
    if (!serversMap) return [];
    return Object.entries(serversMap).map(([name, type]) => ({
      ...type,
      name,
    }));
  }

  // ─── User data (cloud-init) ────────────────────────────────────────────────

  /**
   * Set cloud-init user data on an instance.
   * The generated UserDataApi uses the browser File type — bypass with raw axios.
   */
  async setUserData(
    token: string,
    zone: string,
    serverId: string,
    cloudInit: string,
  ): Promise<void> {
    const url = `https://api.scaleway.com/instance/v1/zones/${zone}/servers/${serverId}/user_data/cloud-init`;
    await axios.patch(url, cloudInit, {
      headers: {
        'X-Auth-Token': token,
        'Content-Type': 'text/plain',
      },
      timeout: this.timeout,
    });
  }

  // ─── Security Group methods ────────────────────────────────────────────────

  async createSecurityGroup(
    token: string,
    zone: string,
    payload: CreateSecurityGroupRequest,
  ): Promise<ScalewayInstanceV1SecurityGroup> {
    const api = this.createSecurityGroupsApi(token);
    try {
      const response = await api.createSecurityGroup(
        zone as unknown as CreateSecurityGroupZoneEnum,
        payload,
      );
      return response.data.security_group;
    } catch (error) {
      this.logger.error(
        `createSecurityGroup 400 body: ${JSON.stringify(error?.response?.data)}`,
      );
      throw error;
    }
  }

  async getSecurityGroup(
    token: string,
    zone: string,
    sgId: string,
  ): Promise<ScalewayInstanceV1SecurityGroup | null> {
    try {
      const api = this.createSecurityGroupsApi(token);
      const response = await api.getSecurityGroup(
        zone as unknown as GetSecurityGroupZoneEnum,
        sgId,
      );
      return response.data.security_group || null;
    } catch (error) {
      if (error?.response?.status === 404) return null;
      throw error;
    }
  }

  async listSecurityGroups(
    token: string,
    zone: string,
  ): Promise<ScalewayInstanceV1SecurityGroup[]> {
    const api = this.createSecurityGroupsApi(token);
    const response = await api.listSecurityGroups(
      zone as unknown as ListSecurityGroupsZoneEnum,
    );
    return response.data.security_groups || [];
  }

  async listSecurityGroupRules(
    token: string,
    zone: string,
    sgId: string,
  ): Promise<ScalewayInstanceV1SecurityGroupRule[]> {
    const api = this.createSecurityGroupsApi(token);
    const all: ScalewayInstanceV1SecurityGroupRule[] = [];
    let page = 1;
    // Scaleway paginates rules; per_page maxes at 100.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await api.listSecurityGroupRules(
        zone as unknown as ListSecurityGroupRulesZoneEnum,
        sgId,
        100,
        page,
      );
      const rules = response.data.rules || [];
      all.push(...rules);
      if (rules.length < 100) break;
      page++;
    }
    return all;
  }

  async setSecurityGroupRules(
    token: string,
    zone: string,
    sgId: string,
    rules: ScalewayInstanceV1SetSecurityGroupRulesRequestRule[],
  ): Promise<void> {
    const api = this.createSecurityGroupsApi(token);
    const request: SetSecurityGroupRulesRequest = { rules };
    await api.setSecurityGroupRules(
      zone as unknown as SetSecurityGroupRulesZoneEnum,
      sgId,
      request,
    );
  }

  async deleteSecurityGroup(
    token: string,
    zone: string,
    sgId: string,
  ): Promise<void> {
    const api = this.createSecurityGroupsApi(token);
    await api.deleteSecurityGroup(
      zone as unknown as DeleteSecurityGroupZoneEnum,
      sgId,
    );
  }

  async applySecurityGroupToServer(
    token: string,
    zone: string,
    serverId: string,
    sgId: string,
  ): Promise<void> {
    const api = this.createInstancesApi(token);
    const securityGroup: ScalewayInstanceV1SecurityGroupTemplate = { id: sgId };
    const request: UpdateServerRequest = { security_group: securityGroup };
    await api.updateServer(
      zone as unknown as UpdateServerZoneEnum,
      serverId,
      request,
    );
  }

  async removeSecurityGroupFromServer(
    token: string,
    zone: string,
    serverId: string,
  ): Promise<void> {
    // A Scaleway Instance always belongs to exactly one security group — there is
    // no "unset". `{ security_group: undefined }` is dropped by JSON.stringify, so
    // updateServer receives `{}` and leaves the assignment untouched — a silent
    // no-op that reports success while the server stays in its old group. The only
    // real detach is reassigning the project's default security group.
    const defaultSgId = await this.getProjectDefaultSecurityGroupId(
      token,
      zone,
    );
    if (!defaultSgId) {
      throw new Error(
        `Cannot detach security group from server ${serverId}: ` +
          `no project-default security group found in zone ${zone}.`,
      );
    }
    const api = this.createInstancesApi(token);
    const securityGroup: ScalewayInstanceV1SecurityGroupTemplate = {
      id: defaultSgId,
    };
    const request: UpdateServerRequest = { security_group: securityGroup };
    await api.updateServer(
      zone as unknown as UpdateServerZoneEnum,
      serverId,
      request,
    );
  }

  async getProjectDefaultSecurityGroupId(
    token: string,
    zone: string,
  ): Promise<string | null> {
    const groups = await this.listSecurityGroups(token, zone);
    const def = groups.find((g) => g.project_default) ?? groups[0];
    return def?.id ?? null;
  }
}
