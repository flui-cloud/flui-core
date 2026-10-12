import { fullWritePause } from './full-migration-view';

describe('fullWritePause when the bridge opened before the fence', () => {
  // Clients reach the read-only standby from the bridge's activation, before
  // the fence lands, so the write pause starts there.
  it('runs from the bridge activation to the promote', () => {
    expect(
      fullWritePause(
        {
          writesStoppedAt: new Date('2026-10-11T10:00:10.000Z'),
          promoteConfirmedAt: new Date('2026-10-11T10:00:12.400Z'),
          fence: null,
        } as never,
        {
          bridgeState: {
            mode: 'bridge',
            state: 'active',
            activatedAt: '2026-10-11T10:00:07.000Z',
          } as never,
          dnsFlippedAt: new Date('2026-10-11T10:00:30.000Z'),
        },
      ),
    ).toEqual({ writePauseMs: 5400, writePauseEndedBy: 'promote' });
  });
});
