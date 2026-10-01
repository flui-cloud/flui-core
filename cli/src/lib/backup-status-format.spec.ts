import {
  alertItemLines,
  coverageAppLabel,
  coverageAppReason,
  decisionLine,
} from './backup-status-format';

describe('backup status lines', () => {
  it('names the app with its slug and cluster', () => {
    expect(
      coverageAppLabel({
        name: 'Orders DB',
        slug: 'pg-orders',
        clusterName: 'wc-1',
        reason: 'no_policy',
      }),
    ).toBe('Orders DB (pg-orders) on wc-1');
    expect(
      coverageAppLabel({
        name: 'web',
        slug: 'web',
        clusterName: null,
        reason: 'x',
      }),
    ).toBe('web');
  });

  it('prefers what protecting the cluster ran into over the coverage reason', () => {
    expect(
      coverageAppReason({
        name: 'pg',
        clusterName: null,
        reason: 'no_policy',
        pending: { reason: 'the database is not running yet' },
      }),
    ).toBe('the database is not running yet');
    expect(
      coverageAppReason({ name: 'pg', clusterName: null, reason: 'no_policy' }),
    ).toBe('no policy covers it');
  });

  it('lists the resources an alert names', () => {
    expect(alertItemLines([{ id: 'p1', name: 'prod-daily' }])).toEqual([
      'prod-daily  p1',
    ]);
    expect(alertItemLines(undefined)).toEqual([]);
  });

  it('says who decided an app is not backed up, when and why', () => {
    const app = {
      name: 'pg-bgs-pitr',
      clusterName: 'wc-2',
      reason: 'not_backed_up_by_choice',
    };
    expect(
      decisionLine({
        ...app,
        decision: {
          note: 'scratch copy of a restore',
          decidedByName: 'Dawit',
          decidedAt: '2026-10-01T09:12:00.000Z',
        },
      }),
    ).toBe(
      'not backed up by choice by Dawit on 2026-10-01: scratch copy of a restore',
    );
    expect(
      decisionLine({ ...app, decision: { decidedAt: '2026-10-01T09:12:00Z' } }),
    ).toBe('not backed up by choice on 2026-10-01');
    expect(decisionLine({ ...app, decision: null })).toBe(
      'not backed up by choice',
    );
  });
});
