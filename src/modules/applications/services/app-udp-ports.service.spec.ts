import { AppUdpPortsService } from './app-udp-ports.service';

describe('AppUdpPortsService', () => {
  const udpRule = (port: string) => ({
    description: 'calls',
    direction: 'in' as const,
    protocol: 'udp' as const,
    port,
    sourceIps: ['0.0.0.0/0'],
  });
  const build = (firewall: object | null, holders: object[] = []) => {
    const applications = {
      findById: jest.fn(),
      findUdpPortHolders: jest.fn(async () => holders),
    };
    const access = { assertCan: jest.fn(async () => undefined) };
    const firewalls = { findOne: jest.fn(async () => firewall) };
    return {
      service: new AppUdpPortsService(
        applications as never,
        access as never,
        firewalls as never,
      ),
      applications,
      access,
    };
  };
  const user = { userId: 'u' } as never;

  it('reads an application’s ports against its cluster firewall, after checking access', async () => {
    const { service, applications, access } = build({
      id: 'fw',
      desiredRules: [udpRule('10000')],
      lastAppliedRules: [udpRule('10000')],
    });
    applications.findById.mockResolvedValue({
      id: 'a',
      clusterId: 'c',
      udpPorts: [
        { name: 'media', port: 10000 },
        { name: 'spare', port: 10001 },
      ],
    });
    const view = await service.view(user, 'a');
    expect(access.assertCan).toHaveBeenCalledWith(
      user,
      'app:read',
      expect.anything(),
    );
    expect(view).toEqual({
      applicationId: 'a',
      clusterId: 'c',
      firewallId: 'fw',
      ports: [
        { name: 'media', port: 10000, state: 'open' },
        { name: 'spare', port: 10001, state: 'closed' },
      ],
    });
  });

  it('calls a cluster without a Flui firewall unmanaged', async () => {
    const { service } = build(null);
    const preview = await service.preview(
      'c',
      [{ name: 'media', port: 10000 }],
      false,
    );
    expect(preview).toEqual({
      clusterId: 'c',
      firewallId: null,
      ports: [
        { name: 'media', port: 10000, state: 'unmanaged', takenBy: null },
      ],
    });
  });

  it('names the app already holding a port', async () => {
    const { service } = build(
      { id: 'fw', desiredRules: [], lastAppliedRules: [] },
      [{ id: 'x', slug: 'calls', udpPorts: [{ name: 'media', port: 10000 }] }],
    );
    const preview = await service.preview(
      'c',
      [{ name: 'media', port: 10000 }],
      false,
    );
    expect(preview.ports).toEqual([
      { name: 'media', port: 10000, state: 'closed', takenBy: 'calls' },
    ]);
  });

  it('never promises a trial app a port', async () => {
    const { service } = build({
      id: 'fw',
      desiredRules: [udpRule('10000')],
      lastAppliedRules: [udpRule('10000')],
    });
    const preview = await service.preview(
      'c',
      [{ name: 'media', port: 10000 }],
      true,
    );
    expect(preview.ports[0].state).toBe('not-published');
  });

  it('asks nothing of the cluster for an app without UDP ports', async () => {
    const { service } = build(null);
    expect(await service.preview('c', [], false)).toEqual({
      clusterId: 'c',
      firewallId: null,
      ports: [],
    });
  });
});
