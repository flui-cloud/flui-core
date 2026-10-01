jest.mock('chalk', () => {
  const same = (text: string) => text;
  return {
    __esModule: true,
    default: { dim: same, bold: same, green: same, yellow: same, red: same },
  };
});

import { describeProtectedApp, engineLabel } from './cluster-protection-format';

describe('what protecting a cluster says about each application', () => {
  it('names the engine in words, never the tool behind the volumes', () => {
    expect(engineLabel('postgres')).toBe('continuous backup (postgres)');
    expect(engineLabel('mariadb-dump')).toBe('scheduled dumps (mariadb)');
    expect(engineLabel('kopia')).toBe('volume copies');
  });

  it('gives the reason for everything that did not get a policy', () => {
    expect(
      describeProtectedApp({
        applicationId: 'a',
        name: 'site',
        outcome: 'skipped',
        reason: 'no_data',
      }),
    ).toContain('site  holds no data');
    expect(
      describeProtectedApp({
        applicationId: 'b',
        name: 'pg',
        outcome: 'failed',
        reason: 'the database is not reachable',
      }),
    ).toContain('the database is not reachable');
  });
});
