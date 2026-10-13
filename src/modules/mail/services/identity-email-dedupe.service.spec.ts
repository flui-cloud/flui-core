import {
  IDENTITY_DEDUPE_TTL_MS,
  IDENTITY_INFLIGHT_STALE_MS,
  IdentityEmailDedupeService,
  identityBodyHash,
} from './identity-email-dedupe.service';

const NOW = new Date('2026-10-13T10:00:00.000Z');

function build(
  options: { won?: boolean; row?: { state: string } | null } = {},
) {
  const repo = {
    query: jest.fn(async () => (options.won ? [{ bodyHash: 'h' }] : [])),
    findOne: jest.fn(async () => options.row ?? null),
    increment: jest.fn(async () => undefined),
    update: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
  };
  return { service: new IdentityEmailDedupeService(repo as never), repo };
}

describe('remembering identity mail already sent', () => {
  it('keys the hash, so a short code cannot be guessed back from it', () => {
    const body = '{"args":{"code":"ABC123"}}';
    const a = identityBodyHash(body, 'key-1');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(identityBodyHash(body, 'key-2'));
    expect(a).toBe(identityBodyHash(Buffer.from(body), 'key-1'));
  });

  it('claims a new message in one conditional upsert, with the TTL and stale windows', async () => {
    const { service, repo } = build({ won: true });
    await expect(service.claim('h', NOW)).resolves.toBe('claimed');
    const [sql, params] = repo.query.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toContain('ON CONFLICT ("bodyHash") DO UPDATE');
    expect(sql).toContain('RETURNING "bodyHash"');
    expect(params).toEqual([
      'h',
      NOW,
      new Date(NOW.getTime() - IDENTITY_DEDUPE_TTL_MS),
      new Date(NOW.getTime() - IDENTITY_INFLIGHT_STALE_MS),
    ]);
  });

  it('reports a message already sent as a duplicate, and counts it', async () => {
    const { service, repo } = build({ won: false, row: { state: 'sent' } });
    await expect(service.claim('h', NOW)).resolves.toBe('duplicate');
    expect(repo.increment).toHaveBeenCalledWith(
      { bodyHash: 'h' },
      'duplicates',
      1,
    );
  });

  it('reports a message another attempt is sending as in flight', async () => {
    const { service, repo } = build({ won: false, row: { state: 'sending' } });
    await expect(service.claim('h', NOW)).resolves.toBe('in_flight');
    expect(repo.increment).not.toHaveBeenCalled();
  });

  it('marks sent, and releases only an unfinished claim', async () => {
    const { service, repo } = build();
    await service.sent('h', NOW);
    expect(repo.update).toHaveBeenCalledWith(
      { bodyHash: 'h' },
      { state: 'sent', updatedAt: NOW },
    );
    await service.release('h');
    expect(repo.delete).toHaveBeenCalledWith({
      bodyHash: 'h',
      state: 'sending',
    });
  });
});
