import {
  identityConsoleHint,
  identityConsoleHintLine,
  identityConsoleLines,
} from './identity-console';

const base = {
  openUntil: null,
  openedAt: null,
  openedBy: null,
  reason: null,
  enforced: true,
  hosts: ['auth.example.com'],
  lastAppliedAt: null,
  lastError: null,
};

describe('identityConsoleLines', () => {
  it('says closed, that sign-in still works, and where visitors go', () => {
    const lines = identityConsoleLines({
      ...base,
      state: 'closed',
      redirectTo: 'https://console.example.com/',
    });
    expect(lines[0]).toBe(
      'The identity provider console is closed. Sign-in is unaffected.',
    );
    expect(lines[1]).toBe(
      'Visitors of the console are sent to https://console.example.com/',
    );
    expect(identityConsoleLines({ ...base, state: 'closed' })[1]).toBe(
      'Visitors of the console get 403 (no dashboard address is known)',
    );
  });

  it('says until when, who and why while open', () => {
    const lines = identityConsoleLines(
      {
        ...base,
        state: 'open',
        openUntil: '2026-10-14T13:00:00.000Z',
        openedBy: 'admin@example.com',
        reason: 'fix an org setting',
      },
      new Date('2026-10-14T12:30:00.000Z'),
    );
    expect(lines[0]).toContain(
      'OPEN until 2026-10-14T13:00:00.000Z (30 min left)',
    );
    expect(lines).toContain('Opened by: admin@example.com');
    expect(lines).toContain('Reason: fix an org setting');
  });

  it('warns when the cluster does not match yet', () => {
    const lines = identityConsoleLines({
      ...base,
      state: 'closed',
      enforced: false,
      lastError: 'apiserver unreachable',
    });
    expect(lines.at(-1)).toBe(
      'Not applied to the cluster yet: apiserver unreachable. Flui retries every minute.',
    );
  });
});

describe('identityConsoleHint', () => {
  it('says the console is closed and how to open it, keeping the address', () => {
    expect(identityConsoleHint('auth.example.com')).toEqual({
      state: 'closed-by-default',
      url: 'https://auth.example.com/ui/console',
      open: 'flui identity console open --reason "<why>"',
      status: 'flui identity console',
    });
    expect(identityConsoleHintLine()).toBe(
      'closed by default; open it for a limited time with `flui identity console open --reason "<why>"`',
    );
  });
});
