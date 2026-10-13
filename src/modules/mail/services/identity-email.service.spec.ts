jest.mock('./mail-send.service', () => ({
  MailSendService: class MailSendService {},
}));
jest.mock('./identity-email-setup.service', () => ({
  IdentityEmailSetupService: class IdentityEmailSetupService {},
}));
jest.mock('./identity-email-dedupe.service', () => ({
  ...jest.requireActual('./identity-email-dedupe.service'),
  IdentityEmailDedupeService: class IdentityEmailDedupeService {},
}));

import {
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { IdentityEmailService } from './identity-email.service';
import { identitySignatureHeader } from '../utils/identity-email-signature.util';

const KEY = 'signing-key';
const NOW = 1_700_000_000_000;
const BODY = {
  contextInfo: {
    recipientEmailAddress: 'visitor@example.com',
    eventType: 'user.human.email.code.added',
  },
  templateData: {
    subject: 'Verify email',
    text: 'Your code is SECRET-CODE-42',
    url: 'https://auth.example.com/verify?code=SECRET-CODE-42',
    buttonText: 'Verify',
  },
};
const RAW = JSON.stringify(BODY);
const signed = (raw = RAW, key = KEY) =>
  identitySignatureHeader(NOW / 1000, raw, key);

function build(
  options: {
    key?: string | null;
    sender?: Record<string, unknown>;
    send?: jest.Mock;
    claim?: string;
  } = {},
) {
  const setup = {
    signingKey: jest
      .fn()
      .mockResolvedValue(options.key === undefined ? KEY : options.key),
    sender: jest.fn().mockResolvedValue(
      options.sender ?? {
        email: 'noreply@example.com',
        name: 'Flui',
        provider: 'scaleway-tem',
      },
    ),
    recordDelivery: jest.fn().mockResolvedValue(undefined),
    recordFailure: jest.fn().mockResolvedValue(undefined),
  };
  const send =
    options.send ??
    jest.fn().mockResolvedValue({
      provider: 'scaleway-tem',
      messageId: 'm1',
      accepted: 1,
    });
  const dedupe = {
    claim: jest.fn().mockResolvedValue(options.claim ?? 'claimed'),
    sent: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const service = new IdentityEmailService(
    setup as never,
    { send } as never,
    dedupe as never,
  );
  return { service, setup, send, dedupe };
}

describe('receiving sign-in mail from the identity provider', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: unknown) => {
          logs.push(String(message));
        });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends a verified message through the transactional sender as identity mail', async () => {
    const { service, send, setup } = build();
    const receipt = await service.receive(signed(), RAW, BODY, NOW);

    expect(receipt).toEqual({
      sent: true,
      provider: 'scaleway-tem',
      messageId: 'm1',
    });
    const [request, using, options] = send.mock.calls[0];
    expect(request.to).toEqual([{ email: 'visitor@example.com' }]);
    expect(request.from).toEqual({
      email: 'noreply@example.com',
      name: 'Flui',
    });
    expect(request.scope).toBe('transactional');
    expect(request.subject).toBe('Verify email');
    expect(using).toBeUndefined();
    expect(options).toEqual({ category: 'identity' });
    expect(setup.recordDelivery).toHaveBeenCalled();
  });

  it('never logs the body, which carries the code', async () => {
    const { service } = build();
    await service.receive(signed(), RAW, BODY, NOW);
    await service
      .receive(signed(RAW, 'wrong'), RAW, BODY, NOW)
      .catch(() => undefined);
    expect(logs.join('\n')).not.toContain('SECRET-CODE-42');
    expect(logs.join('\n')).not.toContain('visitor@example.com');
  });

  it('refuses a bad signature without sending', async () => {
    const { service, send } = build();
    await expect(
      service.receive(signed(RAW, 'other'), RAW, BODY, NOW),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a missing signature', async () => {
    const { service, send } = build();
    await expect(
      service.receive(undefined, RAW, BODY, NOW),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a stale signature', async () => {
    const { service, send } = build();
    await expect(
      service.receive(signed(), RAW, BODY, NOW + 10 * 60_000),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(send).not.toHaveBeenCalled();
  });

  it('answers non-2xx while no signing key is held', async () => {
    const { service, send } = build({ key: null });
    await expect(
      service.receive(signed(), RAW, BODY, NOW),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(send).not.toHaveBeenCalled();
  });

  it('answers non-2xx and records why when no transactional sender is ready', async () => {
    const { service, send, setup } = build({
      sender: { reason: 'no_transactional_connection' },
    });
    await expect(
      service.receive(signed(), RAW, BODY, NOW),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(send).not.toHaveBeenCalled();
    expect(setup.recordFailure).toHaveBeenCalledWith(
      expect.any(String),
      'no_transactional_connection',
    );
  });

  it('refuses a signed message it cannot read', async () => {
    const body = { contextInfo: {}, templateData: { subject: 'x' } };
    const raw = JSON.stringify(body);
    const { service, send } = build();
    await expect(
      service.receive(signed(raw), raw, body, NOW),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(send).not.toHaveBeenCalled();
  });

  it('answers non-2xx when the provider refuses, and records the error', async () => {
    const send = jest.fn().mockRejectedValue(new Error('provider down'));
    const { service, setup } = build({ send });
    await expect(
      service.receive(signed(), RAW, BODY, NOW),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(setup.recordFailure).toHaveBeenCalledWith('provider down');
    expect(setup.recordDelivery).not.toHaveBeenCalled();
  });

  it('marks the message in flight before sending, and sent after, by a keyed hash', async () => {
    const { service, dedupe, send } = build();
    await service.receive(signed(), RAW, BODY, NOW);
    const [hash] = dedupe.claim.mock.calls[0];
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(dedupe.claim.mock.invocationCallOrder[0]).toBeLessThan(
      send.mock.invocationCallOrder[0],
    );
    expect(dedupe.sent).toHaveBeenCalledWith(hash);
  });

  it('answers 2xx without sending a retry of a message already sent', async () => {
    const { service, send, setup } = build({ claim: 'duplicate' });
    await expect(service.receive(signed(), RAW, BODY, NOW)).resolves.toEqual({
      sent: false,
      duplicate: true,
    });
    expect(send).not.toHaveBeenCalled();
    expect(setup.recordFailure).not.toHaveBeenCalled();
  });

  it('answers 409 while the same message is still being sent', async () => {
    const { service, send } = build({ claim: 'in_flight' });
    await expect(
      service.receive(signed(), RAW, BODY, NOW),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(send).not.toHaveBeenCalled();
  });

  it('lets the next retry send when this attempt failed', async () => {
    const send = jest.fn().mockRejectedValue(new Error('provider down'));
    const { service, dedupe } = build({ send });
    await service.receive(signed(), RAW, BODY, NOW).catch(() => undefined);
    expect(dedupe.release).toHaveBeenCalledWith(dedupe.claim.mock.calls[0][0]);
    expect(dedupe.sent).not.toHaveBeenCalled();
  });

  it('claims nothing for a message it refuses', async () => {
    const { service, dedupe } = build();
    await service
      .receive(signed(RAW, 'other'), RAW, BODY, NOW)
      .catch(() => undefined);
    expect(dedupe.claim).not.toHaveBeenCalled();
  });
});
