import {
  CreateSecurityGroupRequest,
  CreateSecurityGroupRequestInboundDefaultPolicyEnum,
  CreateSecurityGroupRequestOutboundDefaultPolicyEnum,
  ScalewayInstanceV1SecurityGroupRule,
  ScalewayInstanceV1SetSecurityGroupRulesRequestRule,
} from './generated/instances';
import {
  INSTANCE_ZONES,
  ScalewayInstancesAdapter,
} from './scaleway-instances.adapter';

/** Tag on a security group copied into another zone, naming the original group. */
export const COPY_OF_TAG = 'flui-copy-of';

export interface ScalewaySecurityGroupRef {
  zone: string;
  sgId: string;
}

/** `<zone>:<security-group-id>`, the firewall id Flui keeps for a Scaleway security group. */
export function parseScalewayFirewallId(
  firewallId: string,
): ScalewaySecurityGroupRef | null {
  const colon = firewallId.indexOf(':');
  if (colon <= 0) return null;
  return {
    zone: firewallId.substring(0, colon),
    sgId: firewallId.substring(colon + 1),
  };
}

export function isZoneCopy(tags: string[] | undefined): boolean {
  return (tags ?? []).some((t) => t.startsWith(`${COPY_OF_TAG}=`));
}

function regionOf(zone: string): string {
  return zone.replace(/-\d+$/, '');
}

/** Only the rules a person can edit: Scaleway adds its own and refuses them back. */
function editableRules(
  raw: ScalewayInstanceV1SecurityGroupRule[],
): ScalewayInstanceV1SetSecurityGroupRulesRequestRule[] {
  return raw
    .filter((r) => r.editable !== false)
    .map((r) => ({
      action: r.action as never,
      protocol: r.protocol as never,
      direction: r.direction as never,
      ip_range: r.ip_range,
      dest_port_from: r.dest_port_from ?? undefined,
      dest_port_to: r.dest_port_to ?? undefined,
      position: r.position,
      editable: true,
    }));
}

/**
 * A Scaleway security group belongs to one zone, and a server takes only a
 * group of its own zone. A cluster across three zones keeps one group as Flui
 * sees it, plus a copy with the same rules in each other zone a server is made
 * in, found again by the tag that names the original.
 */
export class ScalewayZoneSecurityGroups {
  constructor(private readonly adapter: ScalewayInstancesAdapter) {}

  /** The group a server in `zone` takes: the original in its own zone, a copy elsewhere, made on first need. */
  async inZone(
    token: string,
    original: ScalewaySecurityGroupRef,
    zone: string,
  ): Promise<string> {
    if (original.zone === zone) return original.sgId;
    const existing = await this.copyIn(token, original, zone);
    if (existing) return existing;

    const sg = await this.adapter.getSecurityGroup(
      token,
      original.zone,
      original.sgId,
    );
    if (!sg) {
      throw new Error(
        `Security group ${original.sgId} is gone from ${original.zone}, so it cannot be copied to ${zone}`,
      );
    }
    const payload: CreateSecurityGroupRequest = {
      name: sg.name ?? original.sgId,
      description: sg.description ?? sg.name ?? original.sgId,
      tags: [...(sg.tags ?? []), `${COPY_OF_TAG}=${original.sgId}`],
      stateful: sg.stateful ?? true,
      inbound_default_policy: (sg.inbound_default_policy ??
        CreateSecurityGroupRequestInboundDefaultPolicyEnum.Drop) as never,
      outbound_default_policy: (sg.outbound_default_policy ??
        CreateSecurityGroupRequestOutboundDefaultPolicyEnum.Accept) as never,
      project: sg.project,
    };
    const copy = await this.adapter.createSecurityGroup(token, zone, payload);
    const rules = editableRules(
      await this.adapter.listSecurityGroupRules(
        token,
        original.zone,
        original.sgId,
      ),
    );
    if (rules.length) {
      await this.adapter.setSecurityGroupRules(token, zone, copy.id!, rules);
    }
    return copy.id!;
  }

  /** The copies of a group in the other zones of its region. */
  async copies(
    token: string,
    original: ScalewaySecurityGroupRef,
  ): Promise<ScalewaySecurityGroupRef[]> {
    const zones = (INSTANCE_ZONES as string[]).filter(
      (z) => z !== original.zone && regionOf(z) === regionOf(original.zone),
    );
    const found = await Promise.all(
      zones.map(async (zone) => {
        const sgId = await this.copyIn(token, original, zone);
        return sgId ? { zone, sgId } : null;
      }),
    );
    return found.filter((c): c is ScalewaySecurityGroupRef => !!c);
  }

  private async copyIn(
    token: string,
    original: ScalewaySecurityGroupRef,
    zone: string,
  ): Promise<string | null> {
    const tag = `${COPY_OF_TAG}=${original.sgId}`;
    const groups = await this.adapter.listSecurityGroups(token, zone);
    return groups.find((g) => (g.tags ?? []).includes(tag))?.id ?? null;
  }
}
