import { ScalewayFirewallService } from './scaleway-firewall.service';
import { toScalewayZone } from './scaleway-zone.util';

describe('Scaleway security group zone', () => {
  function build() {
    const instancesAdapter = {
      createSecurityGroup: jest.fn().mockResolvedValue({ id: 'sg-1' }),
      setSecurityGroupRules: jest.fn().mockResolvedValue(undefined),
      listServers: jest.fn().mockResolvedValue([]),
    };
    const service = new ScalewayFirewallService(
      { getActiveApiToken: jest.fn().mockResolvedValue('token') } as any,
      { toRecord: () => ({}) } as any,
      instancesAdapter as any,
      { getDefaultProjectId: jest.fn().mockResolvedValue('project') } as any,
    );
    return { service, instancesAdapter };
  }

  it('creates the security group in the zone of the cluster it protects', async () => {
    const { service, instancesAdapter } = build();

    const result = await service.createFirewall({
      name: 'flui-workload',
      labels: [],
      rules: [],
      applyToLabelSelector: 'flui-cluster-id=c1',
      location: 'nl-ams',
    });

    expect(instancesAdapter.createSecurityGroup).toHaveBeenCalledWith(
      'token',
      'nl-ams-1',
      expect.anything(),
    );
    expect(result.firewallId).toBe('nl-ams-1:sg-1');
  });

  it('maps a region to its first zone and keeps an explicit zone', () => {
    expect(toScalewayZone('pl-waw')).toBe('pl-waw-1');
    expect(toScalewayZone('fr-par-2')).toBe('fr-par-2');
    expect(toScalewayZone(undefined)).toBe('fr-par-1');
  });
});
