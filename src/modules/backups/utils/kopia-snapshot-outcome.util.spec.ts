import {
  parseKopiaSnapshotLog,
  snapshotRecordFrom,
  uploadedBytes,
} from './kopia-snapshot-outcome.util';

describe('what a snapshot Job reports', () => {
  const primary = {
    id: 'aaaa0000bbbb1111cccc2222dddd3333',
    source: {
      userName: 'flui',
      host: 'flui-app-1',
      path: '/flui/volumes/data-web',
    },
    rootEntry: { obj: 'kf0c', summ: { size: 5300016, files: 4 } },
  };
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
  const log = [
    'Snapshotting flui@flui-app-1:/flui/volumes/data-web ...',
    'FLUI_KOPIA_CREATED=1',
    `FLUI_KOPIA_SNAPSHOT=${b64(primary)}`,
    'FLUI_KOPIA_BYTES_BEFORE=5001585',
    'FLUI_KOPIA_BYTES_AFTER=5344985',
    'FLUI_KOPIA_SECONDS=3',
    'FLUI_KOPIA_MAINTENANCE=full',
    'FLUI_KOPIA_VERIFIED=ok',
    `FLUI_KOPIA_SNAPSHOTS=${b64([primary])}`,
  ].join('\n');

  it('is read back from the log markers', () => {
    const outcome = parseKopiaSnapshotLog(log);
    expect(outcome.primary?.id).toBe(primary.id);
    expect(outcome.created).toBe(true);
    expect(outcome.maintenance).toBe('full');
    expect(outcome.verified).toBe('ok');
    expect(outcome.listed.map((s) => s.id)).toEqual([primary.id]);
    expect(uploadedBytes(outcome)).toBe(343400);
  });

  it('becomes the ledger record, with sizes, format and the spot check', () => {
    const now = new Date('2026-10-01T02:00:00Z');
    expect(
      snapshotRecordFrom(parseKopiaSnapshotLog(log), {
        repositoryPrefix: 'kopia/app-1/',
        pinned: false,
        now,
      }),
    ).toEqual({
      snapshotId: primary.id,
      rootObject: 'kf0c',
      source: 'flui@flui-app-1:/flui/volumes/data-web',
      repositoryPrefix: 'kopia/app-1/',
      logicalBytes: 5300016,
      fileCount: 4,
      uploadedBytes: 343400,
      repositoryBytes: 5344985,
      compression: 'zstd-fastest',
      encryption: 'AES256-GCM-HMAC-SHA256',
      splitter: 'DYNAMIC-1M-BUZHASH',
      durationSeconds: 3,
      pinned: false,
      maintenance: 'full',
      verifiedAt: now.toISOString(),
      kopiaVersion: '0.23.1',
    });
  });

  it('says unknown rather than a negative upload when maintenance freed space', () => {
    expect(
      uploadedBytes({ bytesBefore: 10, bytesAfter: 5 } as any),
    ).toBeUndefined();
    expect(() =>
      snapshotRecordFrom(parseKopiaSnapshotLog('nothing'), {
        repositoryPrefix: 'p',
        pinned: true,
      }),
    ).toThrow(/did not report a snapshot/);
  });
});
