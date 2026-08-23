import { ApiKeyService } from './api-key.service';
import { ApiKeyEntity } from '../entities/api-key.entity';
import { hashApiKey, API_KEY_PREFIX } from '../utils/api-key-hash.util';

/**
 * Decision 76. The table used to hold `flui_<uuid>` verbatim, so a database
 * dump was a dump of the live credentials. What is asserted here is not only
 * that the digest is stored — it is that nothing on the installation can hand
 * a key back, and that the lookup still finds a key by what the caller presents.
 */

const repo = () => {
  const rows: ApiKeyEntity[] = [];
  return {
    rows,
    save: jest.fn(async (row: Partial<ApiKeyEntity>) => {
      const saved = { id: `id-${rows.length}`, ...row } as ApiKeyEntity;
      rows.push(saved);
      return saved;
    }),
    findOne: jest.fn(
      async ({ where }: { where: Partial<ApiKeyEntity> }) =>
        rows.find((r) =>
          Object.entries(where).every(
            ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
          ),
        ) ?? null,
    ),
  };
};

describe('ApiKeyService — hash at rest', () => {
  it('stores the digest and returns the credential exactly once', async () => {
    const r = repo();
    const service = new ApiKeyService(r as never);

    const { entity, plaintext } = await service.generateApiKey('agent', 'u1');

    expect(plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(entity.keyHash).toBe(hashApiKey(plaintext));
    // The credential itself appears nowhere in what was written.
    expect(JSON.stringify(r.rows)).not.toContain(plaintext);
  });

  it('finds a key by the digest of what was presented', async () => {
    const r = repo();
    const service = new ApiKeyService(r as never);
    const { plaintext } = await service.generateApiKey('agent', 'u1');

    await expect(service.findValid(plaintext)).resolves.toMatchObject({
      name: 'agent',
    });
    await expect(service.findValid('flui_not-the-key')).resolves.toBeNull();
  });

  it('does not authenticate the stored value itself', async () => {
    const r = repo();
    const service = new ApiKeyService(r as never);
    const { entity } = await service.generateApiKey('agent', 'u1');

    // Whoever reads the row holds this string, and it opens nothing.
    await expect(service.findValid(entity.keyHash)).resolves.toBeNull();
  });

  it('adopts a key minted outside, once', async () => {
    const r = repo();
    const service = new ApiKeyService(r as never);

    await expect(
      service.adoptExternalKey(
        'flui_from-the-installer',
        'cli-bootstrap',
        'cli-bootstrap',
      ),
    ).resolves.toBe('seeded');
    await expect(
      service.adoptExternalKey(
        'flui_from-the-installer',
        'cli-bootstrap',
        'cli-bootstrap',
      ),
    ).resolves.toBe('already-present');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].keyHash).toBe(hashApiKey('flui_from-the-installer'));
    await expect(
      service.findValid('flui_from-the-installer'),
    ).resolves.not.toBeNull();
  });
});

describe('the migration premise: nothing is invalidated', () => {
  it('a plaintext already in the column hashes to what the lookup will ask for', () => {
    // What `ApiKeyHashAtRest1785300000000` does to every existing row, and why
    // a key issued before the change keeps working after it.
    const alreadyStored = 'flui_2c0d0a1e-1111-2222-3333-444455556666';
    expect(hashApiKey(alreadyStored)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(alreadyStored)).toBe(hashApiKey(alreadyStored));
  });

  it('re-hashing a digest is detectable, so the migration is safe to meet twice', () => {
    const digest = hashApiKey('flui_anything');
    expect(/^[0-9a-f]{64}$/.test(digest)).toBe(true);
    expect(/^[0-9a-f]{64}$/.test('flui_anything')).toBe(false);
  });
});
