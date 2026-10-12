import { labelCell, measureRows } from './migration-measures-view';

describe('measureRows', () => {
  it('renders a physical full migration as the API reports it', () => {
    expect(
      measureRows({
        kind: 'physical',
        link: {
          state: 'closed',
          listenerNode: 'hz-worker-1',
          dialerNode: 'scw-master',
          handshakeSeen: true,
        },
        baseBackup: { phase: 'done', lagBytes: null },
        fence: {
          appliedAt: '2026-10-11T10:00:00.000Z',
          fenceLsn: '0/5A000110',
          promoteIssuedAt: '2026-10-11T10:00:03.000Z',
          released: false,
        },
        writePauseMs: 6512,
        writePauseEndedBy: 'bridge',
        interruptionMs: 42000,
        nextSteps: [
          { key: 'protect-database', text: 'Protect the new database.' },
          { key: 'destroy-source', text: 'Destroy the source.' },
        ],
      }),
    ).toEqual([
      ['Kind', 'physical'],
      ['Link', 'closed, hz-worker-1 listens, scw-master dials, handshake seen'],
      ['Copy', 'done'],
      [
        'Fence',
        'applied 2026-10-11T10:00:00.000Z, LSN 0/5A000110, promote asked 2026-10-11T10:00:03.000Z, held',
      ],
      ['Write pause', '6.5s (until the bridge forwarded to the destination)'],
      ['Interruption', '42.0s (stopped while its volumes moved)'],
      ['Next', 'Protect the new database.'],
      ['', 'Destroy the source.'],
    ]);
  });

  it('says a database migration pause ends at the promote, and shows the replay lag', () => {
    expect(
      measureRows({
        kind: 'physical',
        baseBackup: { phase: 'done', lagBytes: 2048 },
        writePauseMs: 2500,
      }),
    ).toEqual([
      ['Kind', 'physical'],
      ['Copy', 'done, 2048 bytes to replay'],
      ['Write pause', '2.5s (until the destination was promoted)'],
    ]);
  });

  it('names the DNS switch when no bridge ended the pause', () => {
    expect(
      measureRows({ writePauseMs: 12000, writePauseEndedBy: 'dns' }),
    ).toEqual([['Write pause', '12.0s (until DNS moved to the destination)']]);
  });

  it('names the promote when the bridge already forwarded before the fence', () => {
    expect(
      measureRows({ writePauseMs: 2400, writePauseEndedBy: 'promote' }),
    ).toEqual([['Write pause', '2.4s (until the destination was promoted)']]);
  });

  it('shows the WAL cap Flui put on the source with its note', () => {
    expect(
      measureRows({
        sourceWalCap: {
          value: '2048MB',
          note: 'Caps every slot on the source.',
        },
      }),
    ).toEqual([
      ['WAL cap', '2048MB'],
      ['', 'Caps every slot on the source.'],
    ]);
  });

  it('prints nothing the API did not report', () => {
    expect(measureRows({ kind: null, link: null, nextSteps: [] })).toEqual([]);
  });

  it('keeps a space after a label wider than the column', () => {
    expect(labelCell('Kind')).toBe('Kind:       ');
    expect(labelCell('Write pause')).toBe('Write pause: ');
    expect(labelCell('')).toBe('            ');
  });

  it('shows the poolers holding writes, who was cut at the deadline, and that writes waited', () => {
    expect(
      measureRows({
        pooler: {
          paused: false,
          pausedAt: '2026-10-12T10:00:00Z',
          resumedAt: '2026-10-12T10:00:08Z',
          resumedBy: 'retarget',
          sourceLeftPaused: true,
          deadlineMs: 5000,
          cut: [
            { clientApp: 'worker', heldMs: 6100 },
            { clientApp: null, heldMs: null },
          ],
        },
        writePauseMs: 8000,
        writePauseEndedBy: 'resume',
      }),
    ).toEqual([
      [
        'Pooler',
        'paused 2026-10-12T10:00:00Z, resumed 2026-10-12T10:00:08Z, deadline 5.0s',
      ],
      ['', 'source pooler left paused'],
      ['Cut', 'worker (transaction open about 6.1s)'],
      ['', 'unnamed client'],
      ['Write pause', '8.0s (writes waited in the poolers, none failed)'],
    ]);
  });

  it('says a rollback ended the pause and leaves the source line out', () => {
    expect(
      measureRows({
        pooler: {
          paused: false,
          pausedAt: '2026-10-12T10:00:00Z',
          resumedAt: '2026-10-12T10:00:03Z',
          resumedBy: 'rollback',
          sourceLeftPaused: false,
          deadlineMs: 5000,
          cut: [],
        },
      }),
    ).toEqual([
      [
        'Pooler',
        'paused 2026-10-12T10:00:00Z, resumed 2026-10-12T10:00:03Z by rollback, deadline 5.0s',
      ],
    ]);
  });
});
