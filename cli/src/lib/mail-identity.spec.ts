import { MailIdentityStatus, mailIdentityLines } from './mail-identity';

const base: MailIdentityStatus = {
  state: 'active',
  reason: null,
  mailProvider: 'scaleway-tem',
  providerId: 'p1',
  active: true,
  endpoint: 'http://flui-api/api/v1/identity/email',
  lastSyncAt: '2026-10-13T10:00:00.000Z',
  lastSyncError: null,
  lastDeliveryAt: '2026-10-13T10:05:00.000Z',
  lastErrorAt: null,
  lastError: null,
};

describe('flui mail identity output', () => {
  it('names the provider carrying sign-in mail', () => {
    const lines = mailIdentityLines(base);
    expect(lines[0]).toBe('Sign-in emails are sent through scaleway-tem');
    expect(lines).toContain('Last delivery: 2026-10-13T10:05:00.000Z');
  });

  it('explains why sign-in mail is not going through Flui', () => {
    const lines = mailIdentityLines({
      ...base,
      state: 'not_configured',
      reason: 'no_transactional_connection',
      mailProvider: null,
      providerId: null,
      endpoint: null,
      lastDeliveryAt: null,
    });
    expect(lines[0]).toBe('Sign-in emails are not sent through Flui yet');
    expect(lines[1]).toContain('flui mail connect');
  });

  it('shows the last error', () => {
    const lines = mailIdentityLines({
      ...base,
      state: 'attention',
      reason: 'sender_not_ready',
      lastError: 'provider down',
      lastErrorAt: '2026-10-13T10:06:00.000Z',
    });
    expect(lines.join('\n')).toContain('Last error: provider down');
  });
});
