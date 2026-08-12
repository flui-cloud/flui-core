import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

// Only the DI token is needed here, but importing the real service drags in the
// credential chain and, through it, an ESM-only Kubernetes client that Jest
// cannot parse. Stubbing the module keeps this a unit test of the invite logic.
jest.mock('./mail-send.service', () => ({
  MailSendService: class MailSendService {},
}));

import { InviteMailService } from './invite-mail.service';
import { MailSendService } from './mail-send.service';

function build(env: Record<string, string> = {}, send: jest.Mock = jest.fn()) {
  return Test.createTestingModule({
    providers: [
      InviteMailService,
      { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
      { provide: MailSendService, useValue: { send } },
    ],
  })
    .compile()
    .then((m) => ({ service: m.get(InviteMailService), send }));
}

const INVITE = {
  to: 'new@example.com',
  inviteLink: 'https://auth.example.com/invite?code=abc',
};

describe('InviteMailService', () => {
  it('does not send at all until a sender address is configured', async () => {
    // Guessing a sender on an unverified domain produces mail that is silently
    // discarded, which from here looks exactly like success.
    const { service, send } = await build({});
    expect(service.configured()).toBe(false);
    expect(await service.sendInvite(INVITE)).toEqual({
      sent: false,
      reason: 'not_configured',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the link as transactional mail, which is what an invitation is', async () => {
    const send = jest.fn(async (_req: Record<string, unknown>) => ({
      provider: 'scaleway-tem',
      messageId: 'm1',
      accepted: 1,
    }));
    const { service } = await build({ MAIL_FROM: 'noreply@example.com' }, send);

    const outcome = await service.sendInvite({
      ...INVITE,
      firstName: 'Ada',
      invitedBy: 'dawit',
    });

    expect(outcome).toEqual({ sent: true, messageId: 'm1' });
    const message = send.mock.calls[0]![0];
    expect(message.scope).toBe('transactional');
    expect(message.to).toEqual([{ email: 'new@example.com' }]);
    expect(message.text).toContain(INVITE.inviteLink);
    expect(message.text).toContain('Hi Ada,');
    expect(message.text).toContain('by dawit');
  });

  it('invents no filler name when there is none', async () => {
    const send = jest.fn(async (_req: Record<string, unknown>) => ({
      provider: 'scaleway-tem',
      messageId: null,
      accepted: 1,
    }));
    const { service } = await build({ MAIL_FROM: 'noreply@example.com' }, send);

    await service.sendInvite(INVITE);
    const message = send.mock.calls[0]![0];
    expect(message.text).toContain('Hi,');
    expect(message.text).not.toMatch(/Hi undefined/);
  });

  it('reports a failure instead of throwing, so the invitation survives it', async () => {
    // The link works when pasted into a chat window. Losing it because the
    // mailer was misconfigured would be strictly worse than never trying.
    const send = jest.fn(async (_req: Record<string, unknown>) => {
      throw new Error('provider refused');
    });
    const { service } = await build({ MAIL_FROM: 'noreply@example.com' }, send);

    await expect(service.sendInvite(INVITE)).resolves.toEqual({
      sent: false,
      reason: 'send_failed',
    });
  });
});
