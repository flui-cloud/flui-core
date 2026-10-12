jest.mock('@kubernetes/client-node', () => ({}));

import { FullMigrationOpsService } from './full-migration-ops.service';
import { DbMigrationStatus } from '../../db-lifecycle/enums/db-migration.enum';

describe('FullMigrationOpsService.waitDb inside the write pause', () => {
  afterEach(() => jest.useRealTimers());

  it('sees the promote within a second when asked to poll fast', async () => {
    jest.useFakeTimers();
    const statuses = [DbMigrationStatus.CUTOVER, DbMigrationStatus.COMPLETED];
    const ops = new FullMigrationOpsService(
      {} as never,
      {} as never,
      { findOne: jest.fn(async () => ({ status: statuses.shift() })) } as never,
      {} as never,
    );
    let done = false;
    const waiting = ops
      .waitDb('dbm-1', DbMigrationStatus.COMPLETED, 60_000, 1_000)
      .then(() => (done = true));

    await jest.advanceTimersByTimeAsync(1_000);

    expect(done).toBe(true);
    await waiting;
  });
});

describe('FullMigrationOpsService.waitAppBridge', () => {
  const opsWith = (legs: any[]) =>
    new FullMigrationOpsService(
      {} as never,
      {} as never,
      {} as never,
      {
        findOne: jest.fn(async () =>
          legs.length > 1 ? legs.shift() : legs[0],
        ),
      } as never,
    );

  it('returns once the leg forwards', async () => {
    const ops = opsWith([
      {
        status: 'cutover',
        bridgeState: { mode: 'bridge', state: 'preparing' },
      },
      {
        status: 'cutover',
        bridgeState: {
          mode: 'bridge',
          state: 'active',
          sourceRouteRemovedAt: '2026-10-12T08:00:00Z',
        },
      },
    ]);
    await expect(ops.waitAppBridge('am-1', 10_000, 0)).resolves.toBe('active');
  });

  it('says when the leg fell back to DNS only', async () => {
    const ops = opsWith([
      {
        status: 'ready',
        bridgeState: { mode: 'dns-only', state: 'preparing' },
      },
    ]);
    await expect(ops.waitAppBridge('am-1', 10_000, 0)).resolves.toBe(
      'dns-only',
    );
  });

  it('fails when the leg failed opening it', async () => {
    const ops = opsWith([
      {
        status: 'failed',
        errorMessage: 'no route',
        bridgeState: { mode: 'bridge', state: 'preparing' },
      },
    ]);
    await expect(ops.waitAppBridge('am-1', 10_000, 0)).rejects.toThrow(
      /no route/,
    );
  });
});

describe('FullMigrationOpsService.waitAppBridge after review', () => {
  const opsWith = (legs: any[]) =>
    new FullMigrationOpsService(
      {} as never,
      {} as never,
      {} as never,
      {
        findOne: jest.fn(async () =>
          legs.length > 1 ? legs.shift() : legs[0],
        ),
      } as never,
    );

  it('waits until the source route is gone, not just the activation', async () => {
    const ops = opsWith([
      { status: 'cutover', bridgeState: { mode: 'bridge', state: 'active' } },
    ]);
    await expect(ops.waitAppBridge('am-1', 0, 0)).rejects.toThrow(/in time/);
  });

  it('reports a failed leg even if its bridge still reads active', async () => {
    const ops = opsWith([
      {
        status: 'failed',
        errorMessage: 'saved nothing',
        bridgeState: {
          mode: 'bridge',
          state: 'active',
          sourceRouteRemovedAt: 'x',
        },
      },
    ]);
    await expect(ops.waitAppBridge('am-1', 10_000, 0)).rejects.toThrow(
      /saved nothing/,
    );
  });
});
