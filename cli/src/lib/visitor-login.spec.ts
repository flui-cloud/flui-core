import { admitCliVisitor, mintVisitorKey } from './visitor-login';

function reply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('starting a visit from the command line', () => {
  it('asks for a CLI ticket and returns its nonce', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(reply(201, { nonce: 'n-1', expiresInSeconds: 120 }));
    await expect(
      admitCliVisitor('http://api.test/api/v1', fetchImpl),
    ).resolves.toBe('n-1');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://api.test/api/v1/sandbox/visitor/admission');
    expect(JSON.parse(init.body)).toEqual({ cli: true });
  });

  it('passes on the reason the demo gives for refusing', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      reply(429, {
        code: 'SANDBOX_VISITORS_LIMIT',
        message: 'Too many visitors from here.',
      }),
    );
    await expect(admitCliVisitor('http://api.test', fetchImpl)).rejects.toThrow(
      'Too many visitors from here.',
    );
  });
});

describe('the key of a visit', () => {
  it('names the read groups and never asks for an unscoped key', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        reply(200, [
          { key: 'apps:look', depth: 'look', grantable: true },
          { key: 'apps:change', depth: 'change', grantable: false },
          { key: 'observability:look', depth: 'look', grantable: true },
        ]),
      )
      .mockResolvedValueOnce(
        reply(201, {
          id: 'k1',
          name: 'cli',
          key: 'flui_secret',
          expiresAt: '2026-10-20T10:00:00.000Z',
        }),
      );
    const key = await mintVisitorKey(
      'http://api.test',
      'tok',
      'cli',
      fetchImpl,
    );
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe('http://api.test/auth/api-keys');
    const sent = JSON.parse(init.body);
    expect(sent).toEqual({
      name: 'cli',
      groups: ['apps:look', 'observability:look'],
    });
    expect(sent.unscoped).toBeUndefined();
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(key).toEqual({
      id: 'k1',
      name: 'cli',
      key: 'flui_secret',
      expiresAt: '2026-10-20T10:00:00.000Z',
      groups: ['apps:look', 'observability:look'],
    });
  });

  it('stops when there is nothing to read', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        reply(200, [{ key: 'apps:change', depth: 'change', grantable: false }]),
      );
    await expect(
      mintVisitorKey('http://api.test', 'tok', 'cli', fetchImpl),
    ).rejects.toThrow('no read access');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
