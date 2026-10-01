import {
  mergeBackupListings,
  normalizeBackupPath,
  normalizeRestorePaths,
  primaryLocationOf,
  splitBackupPath,
  toVolumeBackupView,
  volumeRestoreRoute,
} from './kopia-restore.util';

const kopiaRecord = {
  snapshotId: 'aaaa0000bbbb1111cccc2222dddd3333',
  rootObject: 'kf0c',
  source: 'flui@flui-app-1:/flui/volumes/data',
  repositoryPrefix: 'kopia/app-1/',
  logicalBytes: 1000,
  uploadedBytes: 200,
  compression: 'zstd-fastest',
  encryption: 'AES256-GCM-HMAC-SHA256',
  splitter: 'DYNAMIC-1M-BUZHASH',
  pinned: true,
  kopiaVersion: '0.23.1',
};

describe('paths inside a backed-up volume', () => {
  it('are relative to the volume root whatever the caller wrote', () => {
    expect(splitBackupPath('/uploads//2026/')).toEqual(['uploads', '2026']);
    expect(normalizeBackupPath(undefined)).toBe('');
    expect(normalizeBackupPath('a b/[c].txt')).toBe('a b/[c].txt');
  });

  it('never climb out of it', () => {
    expect(() => splitBackupPath('../etc/passwd')).toThrow();
    expect(() => splitBackupPath('a/./b')).toThrow();
    expect(() => splitBackupPath('a\nb')).toThrow();
  });

  it('are named at least once each for a selective restore, and never the root', () => {
    expect(normalizeRestorePaths(['/a', 'a', 'b/'])).toEqual(['a', 'b']);
    expect(() => normalizeRestorePaths([])).toThrow(/at least one/);
    expect(() => normalizeRestorePaths(['/'])).toThrow(
      /restore the whole backup/,
    );
    expect(() => normalizeRestorePaths([3])).toThrow();
  });
});

describe('a listing as the volume restores', () => {
  it('lays the SQLite copies over the volume, directories first', () => {
    const merged = mergeBackupListings(
      [
        { name: 'z.txt', type: 'f', size: 3, mode: '0644', mtime: 't1' },
        { name: 'db', type: 'd', summ: { size: 10 } },
      ],
      [
        { name: 'app.sqlite', type: 'f', size: 8192, mtime: 't2' },
        { name: 'db', type: 'd', summ: { size: 99 } },
      ],
    );
    expect(merged).toEqual([
      { name: 'db', type: 'directory', size: 10, modifiedAt: null, mode: null },
      {
        name: 'app.sqlite',
        type: 'file',
        size: 8192,
        modifiedAt: 't2',
        mode: null,
        consistentCopy: true,
      },
      { name: 'z.txt', type: 'file', size: 3, modifiedAt: 't1', mode: '0644' },
    ]);
  });
});

describe('which mechanism restores a volume backup', () => {
  it('restores a kopia snapshot through kopia', () => {
    const route = volumeRestoreRoute({
      engineClass: 'volume_copy',
      engine: 'kopia',
      manifestSummary: { sink: 'kopia', kopia: kopiaRecord },
      locations: [{ state: 'available' }],
    });
    expect(route).toEqual({ kind: 'kopia', record: kopiaRecord });
  });

  it('keeps the archive path for copies written before kopia', () => {
    expect(
      volumeRestoreRoute({
        engineClass: 'volume_copy',
        manifestSummary: {
          sink: 's3-archive',
          repository: {
            objectKeyPrefix: 'flui/x/exports/web/2026',
            cipher: 'rclone-crypt-v1',
          },
        },
        locations: [
          { state: 'available', objectKeyPrefix: 'flui/x/exports/web/2026' },
        ],
      }),
    ).toEqual({
      kind: 's3-archive',
      objectKeyPrefix: 'flui/x/exports/web/2026',
      encrypted: true,
    });
    expect(
      volumeRestoreRoute({
        engineClass: 'volume_copy',
        engineRef: 'truncated',
        manifestSummary: { sink: 's3-archive' },
        locations: [
          { state: 'available', objectKeyPrefix: 'flui/x/exports/web/full' },
        ],
      }),
    ).toEqual({
      kind: 's3-archive',
      objectKeyPrefix: 'flui/x/exports/web/full',
      encrypted: false,
    });
  });

  it('sends a clone to the snapshot restore, and refuses what is gone', () => {
    expect(
      volumeRestoreRoute({
        engineClass: 'volume_copy',
        manifestSummary: { sink: 'pvc-clone', clonePvcName: 'web-snap-1' },
      }),
    ).toEqual({ kind: 'pvc-clone', clonePvcName: 'web-snap-1' });
    expect(
      volumeRestoreRoute({
        engineClass: 'volume_copy',
        manifestSummary: { sink: 'kopia', kopia: kopiaRecord },
        locations: [{ state: 'expired' }],
      }).kind,
    ).toBe('unavailable');
    expect(volumeRestoreRoute({ engineClass: 'database' }).kind).toBe(
      'unavailable',
    );
  });
});

describe('a volume backup as the surfaces show it', () => {
  const now = new Date('2026-10-01T00:00:00Z');

  it('shows a pinned kopia snapshot as kept until deleted, with both sizes', () => {
    expect(
      toVolumeBackupView(
        {
          id: 'art-1',
          volumeName: 'data',
          createdAt: '2026-09-30T02:00:00Z',
          engine: 'kopia',
          sizeBytes: '1000',
          manifestSummary: {
            sink: 'kopia',
            kopia: kopiaRecord,
            quiesce: 'none',
          },
          locations: [
            { state: 'verified', destinationId: 'd1', bytesStored: '200' },
          ],
        },
        now,
      ),
    ).toEqual({
      id: 'art-1',
      volumeName: 'data',
      engine: 'kopia',
      createdAt: '2026-09-30T02:00:00.000Z',
      kept: 'until-deleted',
      logicalBytes: 1000,
      uploadedBytes: 200,
      stored: 'present',
      encrypted: true,
      restorable: true,
      browsable: true,
      reason: null,
      quiesce: 'none',
      snapshotId: kopiaRecord.snapshotId,
      destinationId: 'd1',
    });
  });

  it('shows a snapshot kopia expired as expired and not restorable', () => {
    const view = toVolumeBackupView(
      {
        id: 'art-2',
        manifestSummary: {
          sink: 'kopia',
          kopia: { ...kopiaRecord, pinned: false },
        },
        locations: [{ state: 'expired', destinationId: 'd1' }],
      },
      now,
    );
    expect(view).toMatchObject({
      kept: 'retention',
      stored: 'expired',
      restorable: false,
      browsable: false,
    });
  });

  it('shows a plaintext archive as restorable but not browsable', () => {
    expect(
      toVolumeBackupView(
        {
          id: 'art-3',
          sizeBytes: '5',
          manifestSummary: { sink: 's3-archive' },
          locations: [{ state: 'available', objectKeyPrefix: 'x/y' }],
        },
        now,
      ),
    ).toMatchObject({
      engine: 'rclone',
      encrypted: false,
      restorable: true,
      browsable: false,
      logicalBytes: 5,
      kept: 'until-deleted',
    });
  });
});

describe('primaryLocationOf', () => {
  it('reads the primary copy even when a replica row comes first', () => {
    const replica = { role: 'replica', destinationId: 'r' };
    const primary = { role: 'primary', destinationId: 'p' };
    expect(primaryLocationOf({ locations: [replica, primary] })).toBe(primary);
    expect(primaryLocationOf({ locations: [replica] })).toBe(replica);
    expect(primaryLocationOf({ locations: null })).toBeUndefined();
  });
});
