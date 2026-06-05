import { Injectable, Logger, Inject } from '@nestjs/common';
import {
  IFirewallProvider,
  CreateFirewallConfig,
  FirewallCreationResult,
  FirewallDetails,
  FirewallRule,
  FirewallFilters,
} from '../../interfaces/firewall-provider.interface';
import { ICredentialProvider } from '../../interfaces/credential-provider.interface';
import { CloudProvider } from '../../enums/cloud-provider.enum';
import { LabelService } from '../../../common/services/label.service';
import {
  ScalewayInstancesAdapter,
  INSTANCE_ZONES,
} from './scaleway-instances.adapter';
import { ScalewayIamAdapter } from './scaleway-iam.adapter';
import {
  CreateSecurityGroupRequest,
  CreateSecurityGroupRequestInboundDefaultPolicyEnum,
  CreateSecurityGroupRequestOutboundDefaultPolicyEnum,
  ScalewayInstanceV1SetSecurityGroupRulesRequestRule,
  ScalewayInstanceV1SetSecurityGroupRulesRequestRuleActionEnum,
  ScalewayInstanceV1SetSecurityGroupRulesRequestRuleDirectionEnum,
  ScalewayInstanceV1SetSecurityGroupRulesRequestRuleProtocolEnum,
  ScalewayInstanceV1SecurityGroup,
  ScalewayInstanceV1SecurityGroupRule,
} from './generated/instances';

// Firewall ID format: "<zone>:<security-group-id>"
type ScalewayFirewallId = { zone: string; sgId: string };

// Resource ID format: "instance:<zone>:<server-id>"
type ScalewayResourceId = { zone: string; serverId: string };

@Injectable()
export class ScalewayFirewallService implements IFirewallProvider {
  private readonly logger = new Logger(ScalewayFirewallService.name);

  constructor(
    @Inject('ICredentialProvider')
    private readonly credentialProvider: ICredentialProvider,
    private readonly labelService: LabelService,
    private readonly instancesAdapter: ScalewayInstancesAdapter,
    private readonly iamAdapter: ScalewayIamAdapter,
  ) {}

  // ─── ID helpers ────────────────────────────────────────────────────────────

  private buildFirewallId(zone: string, sgId: string): string {
    return `${zone}:${sgId}`;
  }

  private parseFirewallId(firewallId: string): ScalewayFirewallId | null {
    const colonIdx = firewallId.indexOf(':');
    if (colonIdx <= 0) return null;
    return {
      zone: firewallId.substring(0, colonIdx),
      sgId: firewallId.substring(colonIdx + 1),
    };
  }

  private parseResourceId(resourceId: string): ScalewayResourceId | null {
    const parts = resourceId.split(':');
    if (parts.length !== 3 || parts[0] !== 'instance') return null;
    return { zone: parts[1], serverId: parts[2] };
  }

  // ─── Rule mapping ──────────────────────────────────────────────────────────

  /**
   * Convert Flui FirewallRule[] to Scaleway SetSecurityGroupRules rules[].
   * Scaleway requires one rule per CIDR — if sourceIps/destinationIps has multiple entries,
   * we emit one rule per CIDR.
   */
  private fluiRulesToScaleway(
    rules: FirewallRule[],
  ): ScalewayInstanceV1SetSecurityGroupRulesRequestRule[] {
    const result: ScalewayInstanceV1SetSecurityGroupRulesRequestRule[] = [];
    let position = 1;

    for (const rule of rules) {
      const direction =
        rule.direction === 'in'
          ? ScalewayInstanceV1SetSecurityGroupRulesRequestRuleDirectionEnum.Inbound
          : ScalewayInstanceV1SetSecurityGroupRulesRequestRuleDirectionEnum.Outbound;

      const protocol = this.mapProtocol(rule.protocol);
      const { portFrom, portTo } = this.parsePort(rule.port);

      // Collect applicable CIDRs (source for inbound, destination for outbound)
      let cidrs: string[];
      if (rule.direction === 'in') {
        cidrs =
          rule.sourceIps && rule.sourceIps.length > 0
            ? rule.sourceIps
            : ['0.0.0.0/0'];
      } else {
        cidrs =
          rule.destinationIps && rule.destinationIps.length > 0
            ? rule.destinationIps
            : ['0.0.0.0/0'];
      }

      for (const cidr of cidrs) {
        result.push({
          action:
            ScalewayInstanceV1SetSecurityGroupRulesRequestRuleActionEnum.Accept,
          protocol,
          direction,
          ip_range: cidr,
          dest_port_from: portFrom,
          dest_port_to: portTo,
          position: position++,
          editable: true,
        });
      }
    }

    return result;
  }

  private mapProtocol(
    protocol: 'tcp' | 'udp' | 'icmp',
  ): ScalewayInstanceV1SetSecurityGroupRulesRequestRuleProtocolEnum {
    switch (protocol) {
      case 'tcp':
        return ScalewayInstanceV1SetSecurityGroupRulesRequestRuleProtocolEnum.Tcp;
      case 'udp':
        return ScalewayInstanceV1SetSecurityGroupRulesRequestRuleProtocolEnum.Udp;
      case 'icmp':
        return ScalewayInstanceV1SetSecurityGroupRulesRequestRuleProtocolEnum.Icmp;
    }
  }

  private parsePort(port?: string): { portFrom?: number; portTo?: number } {
    if (!port) return {};
    const dashIdx = port.indexOf('-');
    if (dashIdx > 0) {
      return {
        portFrom: Number.parseInt(port.substring(0, dashIdx), 10),
        portTo: Number.parseInt(port.substring(dashIdx + 1), 10),
      };
    }
    const p = Number.parseInt(port, 10);
    return { portFrom: p, portTo: p };
  }

  private scalewayRulesToFlui(
    sg: ScalewayInstanceV1SecurityGroup,
    rules: FirewallRule[],
  ): FirewallDetails {
    return {
      id: this.buildFirewallId(sg.zone || '', sg.id || ''),
      name: sg.name || '',
      rules,
      labels: this.tagsToLabels(sg.tags || []),
      appliedTo: (sg.servers || []).map((s) => ({ serverId: s.id || '' })),
    };
  }

  /**
   * Inverse of fluiRulesToScaleway. Translates raw security-group rules from
   * the Scaleway API into Flui's normalized FirewallRule shape so callers
   * (BootstrapSeeder, Dashboard) see the actual ruleset instead of an empty
   * array. Rules with the same protocol/port/direction/action are merged into
   * a single Flui rule with the union of CIDRs.
   */
  private scalewayRuleToFlui(
    raw: ScalewayInstanceV1SecurityGroupRule,
  ): FirewallRule | null {
    const proto = (raw.protocol || '').toLowerCase();
    if (proto !== 'tcp' && proto !== 'udp' && proto !== 'icmp') return null;
    const direction = (raw.direction || '').toLowerCase();
    if (direction !== 'inbound' && direction !== 'outbound') return null;

    const portFrom = raw.dest_port_from;
    const portTo = raw.dest_port_to;
    let port: string | undefined;
    if (portFrom != null) {
      port =
        portTo == null || portTo === portFrom
          ? String(portFrom)
          : `${portFrom}-${portTo}`;
    }

    const cidr = raw.ip_range || '';
    const isIn = direction === 'inbound';
    return {
      direction: isIn ? 'in' : 'out',
      protocol: proto,
      port,
      sourceIps: isIn && cidr ? [cidr] : undefined,
      destinationIps: !isIn && cidr ? [cidr] : undefined,
      description: raw.action === 'drop' ? 'drop' : undefined,
    } as FirewallRule;
  }

  private mergeScalewayRules(
    raw: ScalewayInstanceV1SecurityGroupRule[],
  ): FirewallRule[] {
    // Keep accept rules only — drop rules are not part of Flui's positive
    // model and surface as separate "reject" entries that the Dashboard
    // doesn't render. They remain on Scaleway and aren't lost (we never
    // overwrite via getFirewall).
    const accepts = raw.filter((r) => r.action !== 'drop');
    const out: FirewallRule[] = [];
    const indexByKey = new Map<string, number>();
    for (const r of accepts) {
      const flui = this.scalewayRuleToFlui(r);
      if (!flui) continue;
      const key = `${flui.direction}|${flui.protocol}|${flui.port ?? '*'}`;
      const idx = indexByKey.get(key);
      if (idx == null) {
        indexByKey.set(key, out.length);
        out.push(flui);
      } else {
        const existing = out[idx];
        if (flui.direction === 'in') {
          existing.sourceIps = [
            ...new Set([
              ...(existing.sourceIps ?? []),
              ...(flui.sourceIps ?? []),
            ]),
          ];
        } else {
          existing.destinationIps = [
            ...new Set([
              ...(existing.destinationIps ?? []),
              ...(flui.destinationIps ?? []),
            ]),
          ];
        }
      }
    }
    return out;
  }

  private tagsToLabels(tags: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const tag of tags) {
      const eqIdx = tag.indexOf('=');
      if (eqIdx > 0) {
        result[tag.substring(0, eqIdx)] = tag.substring(eqIdx + 1);
      } else {
        result[tag] = '';
      }
    }
    return result;
  }

  private labelsToTags(labels: Record<string, string>): string[] {
    return Object.entries(labels).map(([k, v]) => `${k}=${v}`);
  }

  // ─── IFirewallProvider methods ─────────────────────────────────────────────

  async createFirewall(
    config: CreateFirewallConfig,
  ): Promise<FirewallCreationResult> {
    this.logger.log(
      `Creating Scaleway security group: ${config.name} ` +
        `[applyToServerIds=${JSON.stringify(config.applyToServerIds ?? [])}` +
        ` applyToLabelSelector=${config.applyToLabelSelector ?? 'none'}]`,
    );

    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );

    // Determine zone from applyToServerIds or default to fr-par-1
    let zone = 'fr-par-1';
    if (config.applyToServerIds && config.applyToServerIds.length > 0) {
      const parsed = this.parseResourceId(config.applyToServerIds[0]);
      if (parsed) zone = parsed.zone;
    }

    this.logger.log(
      `Using zone ${zone} for security group ${config.name} (rules: ${config.rules?.length ?? 0})`,
    );

    const labels = this.labelService.toRecord(config.labels);
    const tags = this.labelsToTags(labels);
    const projectId = await this.iamAdapter.getDefaultProjectId();

    this.logger.log(
      `Creating security group in project ${projectId} with tags: ${JSON.stringify(tags)}`,
    );

    const payload: CreateSecurityGroupRequest = {
      name: config.name,
      description: config.name,
      tags,
      stateful: true,
      inbound_default_policy:
        CreateSecurityGroupRequestInboundDefaultPolicyEnum.Drop,
      outbound_default_policy:
        CreateSecurityGroupRequestOutboundDefaultPolicyEnum.Accept,
      project: projectId,
    };

    const sg = await this.instancesAdapter.createSecurityGroup(
      token,
      zone,
      payload,
    );
    const sgId = sg.id;
    this.logger.log(`Security group created with ID ${sgId} in zone ${zone}`);

    // Set rules if provided
    if (config.rules && config.rules.length > 0) {
      const scRules = this.fluiRulesToScaleway(config.rules);
      this.logger.log(
        `Setting ${scRules.length} rules on security group ${sgId}`,
      );
      await this.instancesAdapter.setSecurityGroupRules(
        token,
        zone,
        sgId,
        scRules,
      );
      this.logger.log(`Rules set on security group ${sgId}`);
    } else {
      this.logger.log(
        `No rules to set on security group ${sgId} (default drop-inbound policy applies)`,
      );
    }

    // Resolve servers to apply the security group to
    const serverIdsToApply: Array<{ zone: string; serverId: string }> = [];

    // From explicit server IDs
    if (config.applyToServerIds && config.applyToServerIds.length > 0) {
      for (const resourceId of config.applyToServerIds) {
        const parsed = this.parseResourceId(resourceId);
        if (parsed) {
          serverIdsToApply.push(parsed);
        } else {
          this.logger.warn(
            `Cannot parse server resource ID: ${resourceId} — skipping`,
          );
        }
      }
    }

    // From label selector (e.g. "flui-cluster-id=<uuid>")
    if (config.applyToLabelSelector) {
      this.logger.log(
        `Resolving servers by label selector: ${config.applyToLabelSelector} in zone ${zone}`,
      );
      try {
        const allServers = await this.instancesAdapter.listServers(
          token,
          zone as any,
        );
        this.logger.log(
          `Found ${allServers.length} total servers in zone ${zone}, filtering by selector`,
        );

        const [labelKey, labelValue] = config.applyToLabelSelector.split('=');
        const matchingServers = allServers.filter((s) => {
          const tags: string[] = (s as any).tags ?? [];
          return tags.includes(`${labelKey}=${labelValue}`);
        });

        this.logger.log(
          `Label selector "${config.applyToLabelSelector}" matched ${matchingServers.length} server(s): ` +
            matchingServers.map((s) => `${s.name}(${s.id})`).join(', '),
        );

        for (const server of matchingServers) {
          if (server.id && server.zone) {
            serverIdsToApply.push({ zone: server.zone, serverId: server.id });
          }
        }
      } catch (err) {
        this.logger.error(
          `Failed to list servers for label selector "${config.applyToLabelSelector}": ${err.message}`,
          err.stack,
        );
      }
    }

    // Apply security group to resolved servers
    if (serverIdsToApply.length > 0) {
      this.logger.log(
        `Applying security group ${sgId} to ${serverIdsToApply.length} server(s)`,
      );
      for (const { zone: serverZone, serverId } of serverIdsToApply) {
        try {
          await this.instancesAdapter.applySecurityGroupToServer(
            token,
            serverZone,
            serverId,
            sgId,
          );
          this.logger.log(
            `Applied security group ${sgId} to server ${serverId} in zone ${serverZone}`,
          );
        } catch (err) {
          this.logger.warn(
            `Failed to apply security group ${sgId} to server ${serverId} (zone ${serverZone}): ${err.message}`,
          );
        }
      }
    } else {
      this.logger.warn(
        `Security group ${sgId} created but NOT applied to any server ` +
          `(no applyToServerIds and label selector "${config.applyToLabelSelector ?? 'none'}" matched 0 servers). ` +
          `It will be applied when nodes are created with this security group ID.`,
      );
    }

    this.logger.log(
      `Security group ${config.name} (${sgId}) ready in zone ${zone}`,
    );
    return {
      firewallId: this.buildFirewallId(zone, sgId),
      appliedToServerIds: config.applyToServerIds,
    };
  }

  async getFirewall(firewallId: string): Promise<FirewallDetails | null> {
    const parsed = this.parseFirewallId(firewallId);
    if (!parsed) return null;

    try {
      const token = await this.credentialProvider.getActiveApiToken(
        CloudProvider.SCALEWAY,
      );
      const sg = await this.instancesAdapter.getSecurityGroup(
        token,
        parsed.zone,
        parsed.sgId,
      );
      if (!sg) return null;

      // Rules are paginated separately on Scaleway — fetch them so callers
      // (BootstrapSeeder, Dashboard /firewalls/cluster/:id) see the real
      // ruleset rather than an empty placeholder.
      const rawRules = await this.instancesAdapter
        .listSecurityGroupRules(token, parsed.zone, parsed.sgId)
        .catch((err) => {
          this.logger.warn(
            `Failed to fetch rules for SG ${parsed.sgId}: ${(err as Error).message}`,
          );
          return [];
        });
      return this.scalewayRulesToFlui(sg, this.mergeScalewayRules(rawRules));
    } catch (error) {
      this.logger.error(
        `Failed to get security group ${firewallId}`,
        error.message,
      );
      return null;
    }
  }

  async listFirewalls(filters?: FirewallFilters): Promise<FirewallDetails[]> {
    try {
      const token = await this.credentialProvider.getActiveApiToken(
        CloudProvider.SCALEWAY,
      );
      const allSgs: ScalewayInstanceV1SecurityGroup[] = [];

      const results = await Promise.allSettled(
        INSTANCE_ZONES.map((zone) =>
          this.instancesAdapter.listSecurityGroups(token, zone),
        ),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          allSgs.push(...result.value);
        }
      }

      let filtered = allSgs;

      if (filters?.name) {
        filtered = filtered.filter((sg) => sg.name === filters.name);
      }

      if (filters?.clusterId) {
        const clusterTag = `flui-cluster-id=${filters.clusterId}`;
        filtered = filtered.filter((sg) =>
          (sg.tags || []).includes(clusterTag),
        );
      }

      if (filters?.labelSelector) {
        // Support "key=value" format matching a tag
        filtered = filtered.filter((sg) =>
          (sg.tags || []).includes(filters.labelSelector),
        );
      }

      // Fetch rules in parallel for the (typically small) filtered set so
      // listFirewalls returns full rule data for the Dashboard list view.
      const enriched = await Promise.all(
        filtered.map(async (sg) => {
          const raw = await this.instancesAdapter
            .listSecurityGroupRules(token, sg.zone || '', sg.id || '')
            .catch(() => []);
          return this.scalewayRulesToFlui(sg, this.mergeScalewayRules(raw));
        }),
      );
      return enriched;
    } catch (error) {
      this.logger.error(
        'Failed to list Scaleway security groups',
        error.message,
      );
      return [];
    }
  }

  async updateFirewallRules(
    firewallId: string,
    rules: FirewallRule[],
  ): Promise<void> {
    const parsed = this.parseFirewallId(firewallId);
    if (!parsed) {
      throw new Error(`Invalid Scaleway firewall ID: ${firewallId}`);
    }

    this.logger.log(`Updating security group ${firewallId} rules`);

    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );
    const scRules = this.fluiRulesToScaleway(rules);
    await this.instancesAdapter.setSecurityGroupRules(
      token,
      parsed.zone,
      parsed.sgId,
      scRules,
    );
  }

  async deleteFirewall(firewallId: string): Promise<void> {
    const parsed = this.parseFirewallId(firewallId);
    if (!parsed) {
      throw new Error(`Invalid Scaleway firewall ID: ${firewallId}`);
    }

    this.logger.log(`Deleting security group ${firewallId}`);

    try {
      const token = await this.credentialProvider.getActiveApiToken(
        CloudProvider.SCALEWAY,
      );
      await this.instancesAdapter.deleteSecurityGroup(
        token,
        parsed.zone,
        parsed.sgId,
      );
    } catch (error) {
      if (error?.response?.status === 404) {
        this.logger.warn(
          `Security group ${firewallId} not found, already deleted`,
        );
        return;
      }
      const data = error?.response?.data;
      const detail = data?.help_message || data?.message || error.message;
      throw new Error(`Failed to delete security group: ${detail}`);
    }
  }

  async applyToServers(firewallId: string, serverIds: string[]): Promise<void> {
    const parsedFw = this.parseFirewallId(firewallId);
    if (!parsedFw) {
      throw new Error(`Invalid Scaleway firewall ID: ${firewallId}`);
    }

    this.logger.log(
      `Applying security group ${firewallId} to ${serverIds.length} servers`,
    );

    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );

    for (const resourceId of serverIds) {
      const parsed = this.parseResourceId(resourceId);
      if (!parsed) {
        this.logger.warn(`Skipping invalid resource ID: ${resourceId}`);
        continue;
      }
      try {
        await this.instancesAdapter.applySecurityGroupToServer(
          token,
          parsed.zone,
          parsed.serverId,
          parsedFw.sgId,
        );
      } catch (err) {
        this.logger.error(
          `Failed to apply security group ${firewallId} to server ${resourceId}: ${err.message}`,
        );
        throw new Error(
          `Failed to apply security group to server ${resourceId}: ${err.message}`,
        );
      }
    }
  }

  async removeFromServers(
    firewallId: string,
    serverIds: string[],
  ): Promise<void> {
    this.logger.log(
      `Removing security group ${firewallId} from ${serverIds.length} servers`,
    );

    const token = await this.credentialProvider.getActiveApiToken(
      CloudProvider.SCALEWAY,
    );

    for (const resourceId of serverIds) {
      const parsed = this.parseResourceId(resourceId);
      if (!parsed) {
        this.logger.warn(`Skipping invalid resource ID: ${resourceId}`);
        continue;
      }
      try {
        await this.instancesAdapter.removeSecurityGroupFromServer(
          token,
          parsed.zone,
          parsed.serverId,
        );
      } catch (err) {
        this.logger.error(
          `Failed to remove security group from server ${resourceId}: ${err.message}`,
        );
        throw new Error(
          `Failed to remove security group from server ${resourceId}: ${err.message}`,
        );
      }
    }
  }
}
