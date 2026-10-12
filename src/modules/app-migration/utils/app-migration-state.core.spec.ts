import { BadRequestException } from '@nestjs/common';
import { AppMigrationStatus } from '../enums/app-migration.enum';
import {
  assertNotOrchestrated,
  bridgeStillNeeded,
  canResumeCutover,
} from './app-migration-state.core';

const mig = (over: any = {}): any => ({
  id: 'mig-1',
  status: AppMigrationStatus.READY,
  ...over,
});

describe('assertNotOrchestrated', () => {
  it('refuses a leg driven directly', () => {
    expect(() =>
      assertNotOrchestrated(mig({ fullMigrationId: 'fm-1' }), false),
    ).toThrow(BadRequestException);
  });

  it('lets the orchestrator and standalone migrations through', () => {
    expect(() =>
      assertNotOrchestrated(mig({ fullMigrationId: 'fm-1' }), true),
    ).not.toThrow();
    expect(() => assertNotOrchestrated(mig(), false)).not.toThrow();
  });
});

describe('canResumeCutover', () => {
  it('offers a failed cutover once the bridge is open', () => {
    expect(
      canResumeCutover(
        mig({
          status: AppMigrationStatus.FAILED,
          bridgeState: { state: 'active' },
        }),
      ),
    ).toBe(true);
  });

  it('offers a CUTOVER row only when the live jobs are known and none holds it', () => {
    const cutover = mig({ status: AppMigrationStatus.CUTOVER });
    expect(canResumeCutover(cutover)).toBe(false);
    expect(canResumeCutover(cutover, new Set(['mig-1']))).toBe(false);
    expect(canResumeCutover(cutover, new Set())).toBe(true);
  });

  it('never offers a full migration leg', () => {
    expect(
      canResumeCutover(
        mig({
          fullMigrationId: 'fm-1',
          status: AppMigrationStatus.CUTOVER,
        }),
        new Set(),
      ),
    ).toBe(false);
  });
});

describe('bridgeStillNeeded', () => {
  it('names when cached answers expire', () => {
    expect(
      bridgeStillNeeded({
        blockedBy: 'ttl',
        closableAt: '2026-10-12T12:00:00.000Z',
        recordTtlSeconds: 60,
      } as any),
    ).toMatch(/until 2026-10-12T12:00:00.000Z \(twice the record's 60 s TTL\)/);
  });

  it('asks to resume the cutover when DNS has not moved', () => {
    expect(bridgeStillNeeded(null)).toMatch(/DNS switch has not completed/);
  });
});
