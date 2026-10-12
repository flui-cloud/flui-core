jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { FullMigrationProcessor } from './full-migration.processor';
import { AppMigrationStatus } from '../../app-migration/enums/app-migration.enum';
import {
  FullMigrationStatus,
  FullStagingMode,
} from '../enums/full-migration.enum';

function setup(appChild: any, dbLeg: any) {
  const fm: any = {
    id: 'fm-1',
    appId: 'app-1',
    dbMigrationId: 'dbm-1',
    appMigrationId: 'am-1',
    targetClusterId: 'dst',
    stagingMode: FullStagingMode.SCALED_DOWN,
  };
  const fmRepo = { save: jest.fn(async (e: any) => e) };
  const proc = new FullMigrationProcessor(
    fmRepo as any,
    { findOne: jest.fn(async () => dbLeg) } as any,
    {
      findOne: jest.fn(async () => appChild),
      save: jest.fn(async (e: any) => e),
    } as any,
    { findById: jest.fn(async () => ({ id: 'app-1' })) } as any,
    {} as any,
    {} as any,
    { cutover: jest.fn() } as any,
    { materializeOnCluster: jest.fn(async () => undefined) } as any,
    { applyRewirePlan: jest.fn() } as any,
    {
      setStep: jest.fn(async () => undefined),
      waitAppAny: jest.fn(async () => undefined),
      completeOperation: jest.fn(async () => undefined),
      fail: jest.fn(async () => undefined),
    } as any,
  );
  return { proc, fm, fmRepo };
}

describe('FullMigrationProcessor write pause', () => {
  const dbLeg = {
    id: 'dbm-1',
    writesStoppedAt: new Date('2026-10-11T10:00:00.000Z'),
    fence: { appliedAt: '2026-10-11T10:00:00.000Z' },
  };

  it('saves the pause up to the bridge activation with the migration', async () => {
    const { proc, fm, fmRepo } = setup(
      {
        id: 'am-1',
        status: AppMigrationStatus.BRIDGING,
        bridgeState: {
          mode: 'bridge',
          state: 'active',
          activatedAt: '2026-10-11T10:00:07.250Z',
        },
      },
      dbLeg,
    );
    await (proc as any).finalizer.finalizeAppLeg(fm);
    expect(fm.status).toBe(FullMigrationStatus.BRIDGING);
    expect(fmRepo.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        writePauseMs: 7250,
        writePauseEndedBy: 'bridge',
      }),
    );
  });

  it('saves the pause up to the DNS switch when no bridge was opened', async () => {
    const { proc, fm } = setup(
      {
        id: 'am-1',
        status: AppMigrationStatus.COMPLETED,
        bridgeState: { mode: 'dns-only', skipReason: 'turned off' },
        dnsFlippedAt: new Date('2026-10-11T10:00:21.000Z'),
      },
      dbLeg,
    );
    await (proc as any).finalizer.finalizeAppLeg(fm);
    expect(fm.status).toBe(FullMigrationStatus.COMPLETED);
    expect(fm.writePauseMs).toBe(21000);
    expect(fm.writePauseEndedBy).toBe('dns');
  });
});
