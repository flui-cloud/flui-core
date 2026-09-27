jest.mock('@kubernetes/client-node', () => ({}));

import { withArchivedEdge } from './pgbackrest.service';

const bases = {
  latestLabel: '20260926-211800F',
  oldestRecoverable: '2026-09-26T21:18:07.000Z',
  newestRecoverable: '2026-09-26T21:18:07.000Z',
  lastFullAt: '2026-09-26T21:18:07.000Z',
  backupCount: 1,
};

describe('continuous backup window', () => {
  it('ends at the last archived WAL, not at the last base backup', () => {
    const epoch = Date.parse('2026-09-26T21:22:36Z') / 1000;
    expect(
      withArchivedEdge(bases, `[...]\nFLUI_LAST_ARCHIVED=${epoch}\n`)
        .newestRecoverable,
    ).toBe('2026-09-26T21:22:36.000Z');
  });

  it('keeps the base edge when the server does not archive to the repository', () => {
    expect(withArchivedEdge(bases, 'FLUI_LAST_ARCHIVED=\n')).toEqual(bases);
  });
});
