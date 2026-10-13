/** The upgrade service with every collaborator faked, shared by its specs. */
import { ConflictException } from '@nestjs/common';
import { VisitorUpgradeService } from './visitor-upgrade.service';
import { loadVisitorConfig } from './visitor.config';

type Row = Record<string, unknown> & { id: string };

export const ENV = {
  ZITADEL_SERVICE_ACCOUNT_PAT: 'service-pat',
  OIDC_ISSUER: 'https://auth.demo.example.com',
};

export const INFO = {
  idpId: 'idp-gh',
  externalUserId: 'gh-42',
  externalUserName: 'mario',
  linkedUserId: null as string | null,
  email: 'mario@example.com',
  emailVerified: true,
  givenName: 'Mario',
  familyName: 'Rossi',
  displayName: 'Mario Rossi',
};

export const VISITOR = {
  id: 'v1',
  kind: 'visitor',
  oidcSub: 'idp-v1',
  blockedAt: null as Date | null,
  email: 'visitor-1@visitors.invalid',
};

export const NOW = new Date('2026-10-13T12:00:00Z');
export const later = (ms: number) => new Date(NOW.getTime() + ms);

export const build = (
  opts: {
    users?: Array<Record<string, unknown>>;
    info?: Partial<typeof INFO>;
    flip?: { done: boolean; reason?: string };
  } = {},
) => {
  const rows: Row[] = [];
  const users = opts.users ?? [VISITOR];
  const isNull = (v: unknown) =>
    !!v && typeof v === 'object' && '_type' in (v as object);
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) =>
      isNull(v) ? (row[k] ?? null) === null : row[k] === v,
    );
  const upgrades = {
    create: (row: Record<string, unknown>) => row,
    save: jest.fn(async (row: Record<string, unknown>) => {
      const saved = {
        id: `u${rows.length + 1}`,
        claimedAt: null,
        outcome: null,
        secretHash: null,
        ...row,
      } as Row;
      rows.push(saved);
      return saved;
    }),
    findOne: jest.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((r) => matches(r, where)) ?? null,
    ),
    update: jest.fn(
      async (where: Record<string, unknown>, set: Record<string, unknown>) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, set));
        return { affected: hit.length };
      },
    ),
  };
  const userRepo = {
    findOne: jest.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        users.find((u) =>
          Object.entries(where).every(([k, v]) => u[k] === v),
        ) ?? null,
    ),
  };
  const signIn = {
    upgradeProviders: jest.fn(async () => [
      { provider: 'github', name: 'GitHub', idpId: 'idp-gh' },
    ]),
  };
  const provider = {
    startIntent: jest.fn(async () => ({
      intentId: 'intent-1',
      authUrl: 'https://github.com/login/oauth/authorize?state=intent-1',
    })),
    retrieveIntent: jest.fn(async () => ({ ...INFO, ...opts.info })),
    addIdpLink: jest.fn(async () => undefined),
    removeIdpLink: jest.fn(async () => undefined),
    setEmail: jest.fn(async () => undefined),
    setProfile: jest.fn(async () => undefined),
    clearVisitorMark: jest.fn(async () => undefined),
  };
  const loginClient = { token: jest.fn(async () => 'login-pat') };
  const encryption = {
    encrypt: (v: string) => `enc(${v})`,
    decrypt: (v: string) => v.replace(/^enc\((.*)\)$/, '$1'),
  };
  const links = {
    visitorOrRefuse: jest.fn(async (id: string) => {
      const u = users.find((x) => x.id === id);
      if (u?.kind !== 'visitor') throw new ConflictException('not a visitor');
      return u;
    }),
    createIntent: jest.fn(async () => ({
      nonce: 'link-nonce',
      expiresAt: later(900_000),
    })),
  };
  const merge = {
    flip: jest.fn(async () => opts.flip ?? { done: true, guest: true }),
    fold: jest.fn(async () => ({ done: true })),
  };
  const config = loadVisitorConfig({
    SANDBOX_ENABLED: 'true',
    SANDBOX_VISITORS_ENABLED: 'true',
    SANDBOX_BASE_DOMAIN: 'https://try.example.com',
    PUBLIC_API_URL: 'https://api.example.com/api/v1',
  });
  const service = new VisitorUpgradeService(
    config,
    upgrades as never,
    userRepo as never,
    signIn as never,
    provider as never,
    loginClient as never,
    encryption as never,
    links as never,
    merge as never,
  );
  return { service, rows, provider, merge, links, signIn, upgrades };
};

/** Start, come back from the provider, and return the flow handle the dashboard got. */
export const throughProvider = async (h: ReturnType<typeof build>) => {
  await h.service.start('v1', 'github', '/apps', NOW);
  const target = await h.service.callback(
    { result: 'success', id: 'intent-1', token: 'tok' },
    later(1000),
  );
  return new URL(target).searchParams.get('flow') ?? '';
};
