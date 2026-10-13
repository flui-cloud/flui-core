import { verifyTurnstile } from './turnstile';

describe('verifyTurnstile', () => {
  const answer = (ok: boolean, body: unknown) =>
    jest.fn(async () => ({ ok, json: async () => body }) as Response);

  it('asks Cloudflare with the secret, the token and the address', async () => {
    const fetchImpl = answer(true, { success: true });
    expect(await verifyTurnstile('s', 't', '203.0.113.7', fetchImpl)).toBe(
      true,
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    );
    const body = init.body as URLSearchParams;
    expect(body.get('secret')).toBe('s');
    expect(body.get('response')).toBe('t');
    expect(body.get('remoteip')).toBe('203.0.113.7');
  });

  it('takes anything but a clear yes as a no', async () => {
    expect(
      await verifyTurnstile('s', 't', null, answer(true, { success: false })),
    ).toBe(false);
    expect(
      await verifyTurnstile('s', 't', null, answer(true, { success: 'true' })),
    ).toBe(false);
    expect(
      await verifyTurnstile('s', 't', null, answer(false, { success: true })),
    ).toBe(false);
  });
});
