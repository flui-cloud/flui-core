import {
  FluiNetworkBellService,
  QUIET_ALERT,
} from './flui-network-bell.service';

describe('the bell for a quiet member of the Flui network', () => {
  const make = (emitAlert = jest.fn()) => ({
    emitAlert,
    service: new FluiNetworkBellService(
      { find: jest.fn().mockResolvedValue([{ id: 'u1' }]) } as never,
      {
        find: jest
          .fn()
          .mockResolvedValue([{ id: 'c2', name: 'scw-scaling-test' }]),
      } as never,
      { get: () => ({ emitAlert }) } as never,
    ),
  });

  it('fires when a member goes quiet and resolves when it comes back', async () => {
    const { service, emitAlert } = make();
    const peer = { id: 'p1', clusterId: 'c2', managementIp: '10.250.0.2' };
    await service.ring([
      { kind: 'went-quiet', peer } as never,
      { kind: 'came-back', peer } as never,
    ]);
    expect(emitAlert).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        kind: 'fired',
        alertname: QUIET_ALERT,
        summary: expect.stringContaining(
          'scw-scaling-test (10.250.0.2) stopped answering',
        ),
      }),
    );
    expect(emitAlert).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ kind: 'resolved' }),
    );
  });

  it('never throws, whatever the gateway does', async () => {
    const { service } = make(
      jest.fn(() => {
        throw new Error('socket down');
      }),
    );
    await expect(
      service.ring([
        {
          kind: 'went-quiet',
          peer: { id: 'p', clusterId: 'c2', managementIp: 'x' },
        } as never,
      ]),
    ).resolves.toBeUndefined();
  });
});
