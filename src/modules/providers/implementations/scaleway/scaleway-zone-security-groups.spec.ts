import {
  ScalewayZoneSecurityGroups,
  isZoneCopy,
  parseScalewayFirewallId,
} from './scaleway-zone-security-groups';

describe('Scaleway security groups across the zones of a region', () => {
  const original = { zone: 'fr-par-1', sgId: 'sg-1' };

  function build(
    groupsByZone: Record<string, Array<{ id: string; tags: string[] }>> = {},
  ) {
    const adapter = {
      listSecurityGroups: jest.fn(
        async (_t: string, zone: string) => groupsByZone[zone] ?? [],
      ),
      getSecurityGroup: jest.fn().mockResolvedValue({
        id: 'sg-1',
        name: 'flui-ha-sc',
        tags: ['flui-cluster-id=c1'],
        stateful: true,
        inbound_default_policy: 'drop',
        outbound_default_policy: 'accept',
        project: 'p1',
      }),
      listSecurityGroupRules: jest.fn().mockResolvedValue([
        {
          action: 'accept',
          protocol: 'TCP',
          direction: 'inbound',
          ip_range: '0.0.0.0/0',
          dest_port_from: 443,
          position: 1,
          editable: true,
        },
        {
          action: 'accept',
          protocol: 'TCP',
          direction: 'inbound',
          ip_range: '0.0.0.0/0',
          dest_port_from: 25,
          position: 2,
          editable: false,
        },
      ]),
      createSecurityGroup: jest.fn().mockResolvedValue({ id: 'sg-2' }),
      setSecurityGroupRules: jest.fn().mockResolvedValue(undefined),
    };
    return {
      groups: new ScalewayZoneSecurityGroups(adapter as never),
      adapter,
    };
  }

  it("gives a server in the group's own zone the group itself", async () => {
    const { groups, adapter } = build();
    await expect(groups.inZone('t', original, 'fr-par-1')).resolves.toBe(
      'sg-1',
    );
    expect(adapter.createSecurityGroup).not.toHaveBeenCalled();
  });

  it('copies the group, with its editable rules, the first time a server needs it in another zone', async () => {
    const { groups, adapter } = build();

    await expect(groups.inZone('t', original, 'fr-par-2')).resolves.toBe(
      'sg-2',
    );

    expect(adapter.createSecurityGroup).toHaveBeenCalledWith(
      't',
      'fr-par-2',
      expect.objectContaining({
        name: 'flui-ha-sc',
        tags: ['flui-cluster-id=c1', 'flui-copy-of=sg-1'],
        project: 'p1',
      }),
    );
    const rules = adapter.setSecurityGroupRules.mock.calls[0][3];
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ dest_port_from: 443, editable: true });
  });

  it('reuses the copy a zone already has', async () => {
    const { groups, adapter } = build({
      'fr-par-3': [{ id: 'sg-3', tags: ['flui-copy-of=sg-1'] }],
    });
    await expect(groups.inZone('t', original, 'fr-par-3')).resolves.toBe(
      'sg-3',
    );
    expect(adapter.createSecurityGroup).not.toHaveBeenCalled();
  });

  it('finds the copies only in the other zones of the same region', async () => {
    const { groups, adapter } = build({
      'fr-par-3': [{ id: 'sg-3', tags: ['flui-copy-of=sg-1'] }],
      'nl-ams-1': [{ id: 'sg-9', tags: ['flui-copy-of=sg-1'] }],
    });
    await expect(groups.copies('t', original)).resolves.toEqual([
      { zone: 'fr-par-3', sgId: 'sg-3' },
    ]);
    expect(adapter.listSecurityGroups.mock.calls.map((c) => c[1])).toEqual([
      'fr-par-2',
      'fr-par-3',
    ]);
  });

  it('reads a firewall id and tells a copy apart', () => {
    expect(parseScalewayFirewallId('it-mil-2:sg-7')).toEqual({
      zone: 'it-mil-2',
      sgId: 'sg-7',
    });
    expect(parseScalewayFirewallId('sg-7')).toBeNull();
    expect(isZoneCopy(['flui-copy-of=sg-1'])).toBe(true);
    expect(isZoneCopy(['flui-cluster-id=c1'])).toBe(false);
  });
});
