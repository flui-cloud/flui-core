import {
  DEFAULT_KOPIA_RETENTION,
  describeKopiaRetention,
  kopiaRetentionArgs,
  kopiaRetentionFor,
  kopiaVerifyDue,
  snapshotsGone,
} from './kopia-retention.util';

describe('kopia retention from a policy', () => {
  it('keeps seven daily and four weekly by default, and always the latest', () => {
    expect(kopiaRetentionFor(undefined)).toEqual(DEFAULT_KOPIA_RETENTION);
    expect(kopiaRetentionFor({})).toEqual({
      keepLatest: 1,
      keepHourly: 0,
      keepDaily: 7,
      keepWeekly: 4,
      keepMonthly: 0,
      keepAnnual: 0,
    });
  });

  it('adds three monthly when the policy opts in', () => {
    expect(kopiaRetentionFor({ keepMonthly: true }).keepMonthly).toBe(3);
    expect(kopiaRetentionFor({ keepMonthly: 6 }).keepMonthly).toBe(6);
    expect(kopiaRetentionFor({ keepMonthly: false }).keepMonthly).toBe(0);
  });

  it('never lets a retention empty itself', () => {
    const r = kopiaRetentionFor({
      keepLatest: 0,
      keepDaily: -3,
      keepWeekly: 'x',
    });
    expect(r.keepLatest).toBe(1);
    expect(r.keepDaily).toBe(0);
    expect(r.keepWeekly).toBe(4);
    expect(kopiaRetentionFor({ keepDaily: 10_000 }).keepDaily).toBe(366);
  });

  it('becomes the flags kopia takes, every tier named', () => {
    expect(
      kopiaRetentionArgs(kopiaRetentionFor({ keepMonthly: true })),
    ).toEqual([
      '--keep-latest=1',
      '--keep-hourly=0',
      '--keep-daily=7',
      '--keep-weekly=4',
      '--keep-monthly=3',
      '--keep-annual=0',
    ]);
    expect(describeKopiaRetention(DEFAULT_KOPIA_RETENTION)).toBe(
      '7 daily + 4 weekly (the latest always kept)',
    );
  });
});

describe('the ledger follows what kopia still lists', () => {
  const SRC = 'flui@flui-app-1:/flui/volumes/data';
  const MANUAL = 'flui@flui-app-1:/flui/manual/volumes/data';
  const listed = (...ids: string[]) =>
    ids.map((id) => ({
      id,
      source: {
        userName: 'flui',
        host: 'flui-app-1',
        path: '/flui/volumes/data',
      },
    }));
  const rows = [
    { artifactId: 'a1', snapshotId: 's1', source: SRC },
    { artifactId: 'a2', snapshotId: 's2', source: SRC },
    { artifactId: 'a3', snapshotId: 's3', source: SRC, gone: true },
    { artifactId: 'a4', snapshotId: 'm1', source: MANUAL },
    { artifactId: 'a5', snapshotId: 'x1' },
  ];

  it('marks a row gone once kopia no longer lists its snapshot', () => {
    expect(snapshotsGone(rows, listed('s2'))).toEqual(['a1']);
  });

  it('leaves alone rows of a source the listing did not cover, or of no known source', () => {
    expect(snapshotsGone(rows, listed('s1', 's2'))).toEqual([]);
  });

  it('judges nothing from an empty listing', () => {
    expect(snapshotsGone(rows, [])).toEqual([]);
  });
});

describe('the monthly spot check', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  it('is due when never done, or done thirty days ago', () => {
    expect(kopiaVerifyDue(null, now)).toBe(true);
    expect(kopiaVerifyDue('garbage', now)).toBe(true);
    expect(kopiaVerifyDue(new Date('2026-08-31T00:00:00Z'), now)).toBe(true);
    expect(kopiaVerifyDue(new Date('2026-09-20T00:00:00Z'), now)).toBe(false);
  });
});
