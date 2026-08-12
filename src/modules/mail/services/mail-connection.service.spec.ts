import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MailConnectionService } from './mail-connection.service';
import { MailConnectionEntity } from '../entities/mail-connection.entity';
import { KeyStorageService } from '../../access/services/key-storage.service';

/**
 * An in-memory stand-in for the connections table.
 *
 * It honours only what the service actually leans on — findOne by scope or by
 * provider+scope, save, and the deactivating update — because a fake that
 * pretends to be a query builder tests the fake.
 */
function fakeRepository() {
  let rows: MailConnectionEntity[] = [];
  let seq = 0;

  const matches = (row: MailConnectionEntity, where: Record<string, unknown>) =>
    Object.entries(where).every(
      ([key, value]) => (row as never)[key] === value,
    );

  const repo = {
    rows: () => rows,
    create: jest.fn(
      (data: Partial<MailConnectionEntity>) =>
        ({ ...data }) as MailConnectionEntity,
    ),
    find: jest.fn(async (options?: { where?: Record<string, unknown> }) =>
      options?.where
        ? rows.filter((r) => matches(r, options.where!))
        : [...rows],
    ),
    findOne: jest.fn(
      async (options: { where: Record<string, unknown> }) =>
        rows.find((r) => matches(r, options.where)) ?? null,
    ),
    save: jest.fn(async (row: MailConnectionEntity) => {
      row.id ??= `conn-${++seq}`;
      row.createdAt ??= new Date('2026-08-11T00:00:00Z');
      rows = rows.filter((r) => r.id !== row.id);
      rows.push(row);
      return row;
    }),
    update: jest.fn(
      async (id: string, patch: Partial<MailConnectionEntity>) => {
        rows = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
        return { affected: 1 };
      },
    ),
    delete: jest.fn(async (id: string) => {
      rows = rows.filter((r) => r.id !== id);
      return { affected: 1 };
    }),
    createQueryBuilder: jest.fn(() => {
      let scope: string | undefined;
      const builder = {
        update: () => builder,
        set: () => builder,
        where: (_sql: string, params: { scope?: string }) => {
          scope = params?.scope;
          return builder;
        },
        andWhere: () => builder,
        execute: async () => {
          rows = rows.map((r) =>
            r.scope === scope ? { ...r, isActive: false } : r,
          );
          return { affected: 0 };
        },
      };
      return builder;
    }),
    manager: {
      transaction: async (work: (m: unknown) => Promise<void>) =>
        work({ getRepository: () => repo }),
    },
  };
  return repo;
}

/** Reversible and deterministic, so a test can assert what was stored. */
const fakeKeys = {
  encryptKeyToString: (plain: string) => `enc:${plain}`,
  decryptKeyFromString: (cipher: string) => cipher.replace(/^enc:/, ''),
} as unknown as KeyStorageService;

async function build() {
  const repo = fakeRepository();
  const moduleRef = await Test.createTestingModule({
    providers: [
      MailConnectionService,
      { provide: getRepositoryToken(MailConnectionEntity), useValue: repo },
      { provide: KeyStorageService, useValue: fakeKeys },
    ],
  }).compile();
  return { service: moduleRef.get(MailConnectionService), repo };
}

describe('storing a mail connection', () => {
  it('encrypts the credential and never keeps it in the clear', async () => {
    const { service, repo } = await build();
    await service.upsert({
      provider: 'brevo',
      scope: 'bulk',
      secret: 'xkeysib-abc',
    });

    const [row] = repo.rows();
    // The column holds whatever the encryptor produced, never the argument it
    // was given — the fake is reversible on purpose so the round trip is
    // checkable, which is why the assertion is on the envelope and not on the
    // absence of the plaintext.
    expect(row?.encryptedSecret).toBe('enc:xkeysib-abc');
    expect(row?.encryptedSecret).not.toBe('xkeysib-abc');
    expect(service.secretOf(row!)).toBe('xkeysib-abc');

    // The fingerprint exists to compare accounts across scopes without holding
    // a second copy of the key, so it must not be the key.
    expect(row?.secretFingerprint).toHaveLength(64);
    expect(row?.secretFingerprint).not.toContain('xkeysib');
  });

  it('asks Scaleway for no credential, because it reuses the compute key', async () => {
    const { service, repo } = await build();
    await service.upsert({ provider: 'scaleway-tem', scope: 'transactional' });

    expect(repo.rows()[0]?.credentialSource).toBe('scaleway-compute');
    expect(repo.rows()[0]?.encryptedSecret).toBeNull();
  });

  it('refuses every other provider without one', async () => {
    const { service } = await build();
    await expect(
      service.upsert({ provider: 'brevo', scope: 'bulk' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses ZeptoMail without its regional host, which is the data residency', async () => {
    const { service } = await build();
    await expect(
      service.upsert({
        provider: 'zeptomail',
        scope: 'transactional',
        secret: 'k',
      }),
    ).rejects.toThrow(/regional API host/);
  });

  it('stores a second provider for a scope without moving the mail onto it', async () => {
    const { service, repo } = await build();
    await service.upsert({ provider: 'scaleway-tem', scope: 'transactional' });
    const stored = await service.upsert({
      provider: 'zeptomail',
      scope: 'transactional',
      secret: 'k',
      config: { region: 'api.zeptomail.eu' },
    });

    // Adding one is how you try it out. Sending through it is a separate
    // decision, and taking it silently would move live password resets onto a
    // domain that may be minutes away from verifying.
    expect(stored.isActive).toBe(false);
    expect(repo.rows()).toHaveLength(2);
    expect(
      repo
        .rows()
        .filter((r) => r.isActive)
        .map((r) => r.provider),
    ).toEqual(['scaleway-tem']);
  });

  it('takes the scope when asked to, and only one holds it', async () => {
    const { service, repo } = await build();
    await service.upsert({ provider: 'scaleway-tem', scope: 'transactional' });
    await service.upsert({
      provider: 'zeptomail',
      scope: 'transactional',
      secret: 'k',
      config: { region: 'api.zeptomail.eu' },
      activate: true,
    });

    const active = repo.rows().filter((r) => r.isActive);
    expect(active).toHaveLength(1);
    expect(active[0]?.provider).toBe('zeptomail');
  });

  it('keeps the slot when the provider already in it is reconnected', async () => {
    const { service } = await build();
    await service.upsert({
      provider: 'brevo',
      scope: 'bulk',
      secret: 'old-key',
    });

    // A rotated key is not a change of sender, and dropping the scope on the
    // floor here would stop the mail for no reason anybody asked for.
    const rotated = await service.upsert({
      provider: 'brevo',
      scope: 'bulk',
      secret: 'new-key',
    });
    expect(rotated.isActive).toBe(true);
    expect(service.secretOf(rotated)).toBe('new-key');
  });

  it('hands the scope over on activate, and hands it back the same way', async () => {
    const { service } = await build();
    const first = await service.upsert({
      provider: 'scaleway-tem',
      scope: 'transactional',
    });
    const second = await service.upsert({
      provider: 'zeptomail',
      scope: 'transactional',
      secret: 'k',
      config: { region: 'api.zeptomail.eu' },
    });

    expect((await service.activate(second.id)).isActive).toBe(true);
    expect((await service.byId(first.id)).isActive).toBe(false);

    // The retired one keeps its credential, so switching back is the same call
    // the other way rather than a re-onboarding.
    expect((await service.activate(first.id)).isActive).toBe(true);
    expect((await service.byId(second.id)).isActive).toBe(false);
  });
});

describe('keeping bulk and transactional apart', () => {
  it('refuses the same credential for both scopes', async () => {
    const { service } = await build();
    await service.upsert({
      provider: 'brevo',
      scope: 'transactional',
      secret: 'same-key',
    });

    // The whole reason the invariant exists: a suspension caused by a mailing
    // list would take the password resets with it.
    await expect(
      service.upsert({ provider: 'brevo', scope: 'bulk', secret: 'same-key' }),
    ).rejects.toThrow(/already configured for transactional mail/);
  });

  it('refuses a collision with a stored provider that is not even sending', async () => {
    const { service } = await build();
    await service.upsert({
      provider: 'brevo',
      scope: 'transactional',
      secret: 'key-a',
    });
    const spare = await service.upsert({
      provider: 'zeptomail',
      scope: 'transactional',
      secret: 'key-b',
      config: { region: 'api.zeptomail.eu' },
    });
    expect(spare.isActive).toBe(false);

    // A stored connection exists to be switched to. Accepting the collision now
    // means it surfaces at the click that makes it live, which is the worst
    // moment to find out.
    await expect(
      service.upsert({
        provider: 'zeptomail',
        scope: 'bulk',
        secret: 'key-b',
        config: { region: 'api.zeptomail.eu' },
      }),
    ).rejects.toThrow(/already configured for transactional mail/);
  });

  it('refuses the same sending domain for both scopes', async () => {
    const { service } = await build();
    await service.upsert({
      provider: 'brevo',
      scope: 'transactional',
      secret: 'key-a',
      sendingDomain: 'mail.example.com',
    });

    await expect(
      service.upsert({
        provider: 'brevo',
        scope: 'bulk',
        secret: 'key-b',
        sendingDomain: 'MAIL.example.com',
      }),
    ).rejects.toThrow(/already the sending domain/);
  });

  it('allows two providers at once, which is the healthy configuration', async () => {
    const { service, repo } = await build();
    await service.upsert({
      provider: 'scaleway-tem',
      scope: 'transactional',
      sendingDomain: 'mail.example.com',
    });
    await service.upsert({
      provider: 'brevo',
      scope: 'bulk',
      secret: 'key-b',
      sendingDomain: 'news.example.com',
    });

    expect(repo.rows().filter((r) => r.isActive)).toHaveLength(2);
  });
});

describe('the webhook secret', () => {
  it('is minted once and then kept, because rotating it silences the provider', async () => {
    const { service } = await build();
    const connection = await service.upsert({
      provider: 'brevo',
      scope: 'bulk',
      secret: 'k',
    });

    const first = await service.ensureWebhookSecret(connection);
    expect(first).toHaveLength(64);

    // Re-registering must not invalidate the token the provider already holds:
    // every event it posts would be rejected, which looks exactly like a
    // provider that has gone quiet.
    const stored = await service.byId(connection.id);
    expect(await service.ensureWebhookSecret(stored)).toBe(first);
  });
});
