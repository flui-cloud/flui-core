import { VolumeBackup, resolveBackupId } from './volume-backup-client';
import {
  VOLUME_BACKUP_HEADERS,
  entryColumns,
  renderTable,
  volumeBackupColumns,
} from './volume-backup-format';

const backup = (over: Partial<VolumeBackup> = {}): VolumeBackup => ({
  id: '3f2a91c0-0000-4000-8000-000000000001',
  volumeName: 'data',
  engine: 'kopia',
  createdAt: '2026-10-01T02:00:07.000Z',
  kept: 'retention',
  logicalBytes: 5 * 1024 * 1024,
  uploadedBytes: 1024,
  stored: 'present',
  encrypted: true,
  restorable: true,
  browsable: true,
  reason: null,
  quiesce: 'none',
  snapshotId: 'aaaa0000bbbb1111cccc2222dddd3333',
  destinationId: 'd1',
  ...over,
});

describe('volume backups in the terminal', () => {
  it('prints one row per backup with both sizes', () => {
    expect(volumeBackupColumns(backup())).toEqual([
      '3f2a91c0',
      'data',
      'kopia',
      '2026-10-01 02:00 UTC',
      '5.0 MiB',
      '1.0 KiB',
      'present',
      'retention',
      'yes',
    ]);
    expect(
      volumeBackupColumns(
        backup({
          uploadedBytes: null,
          kept: 'until-deleted',
          browsable: false,
        }),
      ).slice(5),
    ).toEqual(['—', 'present', 'until deleted', 'no']);
  });

  it('aligns columns to the widest cell', () => {
    const lines = renderTable(VOLUME_BACKUP_HEADERS, [
      volumeBackupColumns(backup()),
    ]);
    expect(lines[0].indexOf('VOLUME')).toBe(lines[1].indexOf('data'));
  });

  it('marks directories and online copies in a listing', () => {
    expect(
      entryColumns({
        name: 'app.db',
        type: 'file',
        size: 2048,
        modifiedAt: null,
        mode: '0644',
        consistentCopy: true,
      }),
    ).toEqual(['0644', '2.0 KiB', '—', 'app.db (online copy)']);
    expect(
      entryColumns({
        name: 'uploads',
        type: 'directory',
        size: null,
        modifiedAt: null,
        mode: null,
      })[3],
    ).toBe('uploads/');
  });

  it('finds a backup by id, snapshot id or a unique prefix', () => {
    const list = [
      backup(),
      backup({ id: '3f2b0000-0000-4000-8000-000000000002', snapshotId: 'x' }),
    ];
    expect(resolveBackupId(list, '3f2a').id).toBe(list[0].id);
    expect(resolveBackupId(list, 'aaaa0000bbbb1111cccc2222dddd3333').id).toBe(
      list[0].id,
    );
    expect(() => resolveBackupId(list, '3f2')).toThrow(/matches 2/);
    expect(() => resolveBackupId(list, 'zz')).toThrow(/No volume backup/);
  });
});
