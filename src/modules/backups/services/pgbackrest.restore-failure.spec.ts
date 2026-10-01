jest.mock('@kubernetes/client-node', () => ({}));

import { restoreFailureFrom } from './pgbackrest-config.util';

describe('restoreFailureFrom', () => {
  it('names an image that cannot open an encrypted repository', () => {
    const logs = [
      "2026-10-01 03:59:29.423 P00   WARN: repo1: [FormatError] unable to load info file '/flui/x/pgbackrest/app/encrypted/backup/main/backup.info' or '/flui/x/pgbackrest/app/encrypted/backup/main/backup.info.copy':",
      "2026-10-01 03:59:29.423 P00  ERROR: [075]: unable to find backup set with stop time less than '2026-10-01 03:47:20+00'",
    ].join('\n');
    expect(restoreFailureFrom(logs)).toMatch(/update the flui-postgres image/);
  });

  it('passes on any other pgBackRest error as it was printed', () => {
    expect(
      restoreFailureFrom(
        "P00  ERROR: [075]: unable to find backup set with stop time less than '2026-09-01 00:00:00+00'\n",
      ),
    ).toBe(
      "pgBackRest stopped the restore: unable to find backup set with stop time less than '2026-09-01 00:00:00+00'",
    );
  });

  it('says nothing when the logs hold no error', () => {
    expect(restoreFailureFrom('database system is ready')).toBeNull();
  });
});
