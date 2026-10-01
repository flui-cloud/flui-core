import { planAppProtection } from './cluster-protection.plan';

const support = {
  database: (e: string) => ['postgres', 'mariadb'].includes(e),
  consistentCopy: (e: string) => ['redis', 'valkey'].includes(e),
};
const none = { database: false, volumeCopy: false };
const vol = [{ name: 'data', mountPath: '/data' }];

const app = (over: Record<string, unknown> = {}) => ({
  kind: 'APPLICATION',
  category: 'user',
  systemProtected: false,
  volumes: vol,
  labels: {},
  ...over,
});

describe('which backup an application gets when its cluster is protected', () => {
  it('gives a recognised database its own engine', () => {
    expect(
      planAppProtection(
        app({
          kind: 'DATABASE',
          labels: { 'flui.cloud/db-engine': 'postgres' },
        }),
        none,
        support,
      ),
    ).toEqual({ kind: 'database', engine: 'postgres' });
  });

  it('copies the volumes of an engine Flui can quiesce, and of anything else holding data', () => {
    expect(
      planAppProtection(
        app({ labels: { 'flui.cloud/db-engine': 'redis' } }),
        none,
        support,
      ),
    ).toEqual({ kind: 'volume_copy', engine: 'redis' });
    expect(planAppProtection(app(), none, support)).toEqual({
      kind: 'volume_copy',
    });
  });

  it('leaves a database it cannot back up consistently for a person to decide, never copying it nightly', () => {
    const unknown = planAppProtection(
      app({ labels: { 'flui.cloud/db-engine': 'mongodb' } }),
      none,
      support,
    );
    expect(unknown).toMatchObject({
      kind: 'needs_decision',
      engine: 'mongodb',
    });
    const undeclared = planAppProtection(
      app({ kind: 'DATABASE' }),
      none,
      support,
    );
    expect(undeclared.kind).toBe('needs_decision');
  });

  it('never adds a second policy to an application that has one', () => {
    for (const cover of [
      { database: true, volumeCopy: false },
      { database: false, volumeCopy: true },
    ]) {
      expect(
        planAppProtection(
          app({ labels: { 'flui.cloud/db-engine': 'postgres' } }),
          cover,
          support,
        ),
      ).toEqual({ kind: 'already_protected' });
    }
  });

  it('skips what Flui itself runs and what holds no data', () => {
    expect(
      planAppProtection(app({ systemProtected: true }), none, support),
    ).toEqual({
      kind: 'skip',
      reason: 'system',
    });
    expect(
      planAppProtection(app({ category: 'system' }), none, support).kind,
    ).toBe('skip');
    expect(planAppProtection(app({ volumes: [] }), none, support)).toEqual({
      kind: 'skip',
      reason: 'no_data',
    });
    expect(
      planAppProtection(
        app({ volumes: [], labels: { 'flui.cloud/db-engine': 'mongodb' } }),
        none,
        support,
      ),
    ).toEqual({ kind: 'skip', reason: 'no_data' });
  });

  it('gives nothing to an application a person decided not to back up, protected or not', () => {
    const decided = app({
      kind: 'DATABASE',
      labels: { 'flui.cloud/db-engine': 'postgres' },
      notBackedUpByChoice: true,
    });
    for (const cover of [none, { database: true, volumeCopy: false }]) {
      expect(planAppProtection(decided, cover, support)).toEqual({
        kind: 'skip',
        reason: 'not_backed_up_by_choice',
      });
    }
  });
});
