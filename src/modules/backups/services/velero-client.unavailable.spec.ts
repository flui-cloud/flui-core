jest.mock('@kubernetes/client-node', () => ({}));

import { describeUnavailable } from './velero-client.service';

describe('describeUnavailable', () => {
  it('names the other backups sharing the folder and the way out', () => {
    const msg = describeUnavailable(
      'BackupStorageLocation "flui-dest-a83dad2e" is unavailable: Backup store contains invalid top-level directories: [linkding-7a6d82-h7ppt8 pgbackrest]',
    );
    expect(msg).toContain('linkding-7a6d82-h7ppt8 pgbackrest');
    expect(msg).toContain('upgrade-layout');
  });

  it('carries any other reason through', () => {
    expect(describeUnavailable('AccessDenied')).toContain('AccessDenied');
  });
});
