import { planDbRestore } from './db-restore-plan.util';

const base = {
  requestedTarget: null,
  artifactEngineRef: 'base-1',
  artifactIsNewest: true,
  newestArchived: new Date('2026-09-26T21:22:36Z'),
  noChangesArchived: false,
  replaysToEndWithoutTarget: false,
  now: new Date('2026-09-27T10:00:00Z'),
};

describe('planDbRestore for an engine that needs a moment to replay', () => {
  it('asks for "now" to mean everything archived', () => {
    expect(planDbRestore(base)).toEqual({
      mode: 'latest',
      recoveryTargetTime: base.now,
      note: undefined,
    });
  });

  it('restores the base alone when nothing was archived after it', () => {
    expect(
      planDbRestore({ ...base, newestArchived: null, noChangesArchived: true }),
    ).toMatchObject({ mode: 'latest', restoreSet: 'base-1' });
  });
});
