jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import {
  DbCredentialHandoffService,
  adoptCredentials,
} from './db-credential-handoff.service';

const srcEnv = [
  { name: 'POSTGRES_USER', value: 'app_user' },
  { name: 'POSTGRES_DB', value: 'app_db' },
  { name: 'POSTGRES_PASSWORD', value: 'enc:source-pw', secret: true },
];
const dstEnv = [
  { name: 'POSTGRES_USER', value: 'app_user' },
  { name: 'POSTGRES_DB', value: 'app_db' },
  { name: 'POSTGRES_PASSWORD', value: 'enc:generated-pw', secret: true },
  { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
  { name: 'FLUI_PG_STANDBY', value: '1' },
  {
    name: 'FLUI_CONNECTION_URL',
    value: 'enc:postgres://generated',
    secret: true,
  },
];

describe('adoptCredentials', () => {
  it('gives the destination the source password, clears the standby switch and drops the stale URL', () => {
    const next = adoptCredentials(srcEnv, dstEnv);
    expect(next.find((e) => e.name === 'POSTGRES_PASSWORD')?.value).toBe(
      'enc:source-pw',
    );
    expect(next.find((e) => e.name === 'FLUI_PG_STANDBY')?.value).toBe('');
    expect(next.some((e) => e.name === 'FLUI_CONNECTION_URL')).toBe(false);
    expect(next.find((e) => e.name === 'PGDATA')?.value).toBe(
      '/var/lib/postgresql/data/pgdata',
    );
  });
});

describe('adoptCredentials with the direct address', () => {
  it('drops the stale direct URL too, so both addresses are composed again with the source credentials', () => {
    const next = adoptCredentials(srcEnv, [
      ...dstEnv,
      {
        name: 'FLUI_DIRECT_URL',
        value: 'enc:postgres://generated',
        secret: true,
      },
    ]);
    expect(next.some((e) => e.name === 'FLUI_DIRECT_URL')).toBe(false);
  });
});

describe('DbCredentialHandoffService', () => {
  it('stores the source credentials, patches the live Secret and composes the URL again', async () => {
    const apps = {
      findOne: jest.fn(async ({ where }: any) =>
        where.id === 'src'
          ? { id: 'src', slug: 'pg-a', env: srcEnv }
          : {
              id: 'dst',
              slug: 'pg-b',
              k8sNamespace: 'ns-b',
              clusterId: 'cb',
              env: dstEnv,
            },
      ),
      update: jest.fn(),
    };
    const k8s = { patchSecret: jest.fn() };
    const connectionUrl = { ensureOnExisting: jest.fn() };
    const svc = new DbCredentialHandoffService(
      apps as any,
      {
        findOne: jest.fn(async () => ({ kubeconfigEncrypted: 'enc:kc' })),
      } as any,
      { decrypt: (v: string) => v.replace(/^enc:/, '') } as any,
      k8s as any,
      connectionUrl as any,
    );
    await svc.adoptSourceCredentials('src', 'dst');
    expect(apps.update).toHaveBeenCalledWith('dst', {
      env: expect.arrayContaining([
        expect.objectContaining({
          name: 'POSTGRES_PASSWORD',
          value: 'enc:source-pw',
        }),
      ]),
    });
    expect(k8s.patchSecret).toHaveBeenCalledWith('kc', 'ns-b', 'pg-b-secret', {
      POSTGRES_PASSWORD: 'source-pw',
    });
    expect(connectionUrl.ensureOnExisting).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'dst' }),
    );
  });
});

describe('DbCredentialHandoffService before promote', () => {
  const build = () => {
    const rows: Record<string, any> = {
      src: {
        id: 'src',
        slug: 'pg-a',
        env: srcEnv,
        pooler: {
          enabled: true,
          authPasswordEnc: 'enc:src-auth',
          adminPasswordEnc: 'enc:src-admin',
          routed: true,
        },
      },
      dst: {
        id: 'dst',
        slug: 'pg-b',
        k8sNamespace: 'ns-b',
        clusterId: 'cb',
        env: dstEnv,
        pooler: {
          enabled: true,
          authPasswordEnc: 'enc:dst-auth',
          adminPasswordEnc: 'enc:dst-admin',
          routed: false,
          upstreamClusterIP: '10.43.1.1',
        },
      },
    };
    const apps = {
      findOne: jest.fn(async ({ where }: any) => ({ ...rows[where.id] })),
      update: jest.fn(async (id: string, p: any) => Object.assign(rows[id], p)),
    };
    const connectionUrl = { ensureOnExisting: jest.fn() };
    const svc = new DbCredentialHandoffService(
      apps as any,
      {
        findOne: jest.fn(async () => ({ kubeconfigEncrypted: 'enc:kc' })),
      } as any,
      { decrypt: (v: string) => v.replace(/^enc:/, '') } as any,
      { patchSecret: jest.fn() } as any,
      connectionUrl as any,
    );
    return { svc, rows, connectionUrl };
  };

  it('takes the source identity and recomposes the URLs, keeping the standby switch', async () => {
    const { svc, rows, connectionUrl } = build();
    await svc.adoptSourceIdentity('src', 'dst');
    const env = rows.dst.env as any[];
    expect(env.find((e) => e.name === 'POSTGRES_PASSWORD')?.value).toBe(
      'enc:source-pw',
    );
    expect(env.find((e) => e.name === 'FLUI_PG_STANDBY')?.value).toBe('1');
    expect(env.some((e) => e.name === 'FLUI_CONNECTION_URL')).toBe(false);
    expect(connectionUrl.ensureOnExisting).toHaveBeenCalled();
  });

  it('gives the destination pooler the source pooler password, routed like the source', async () => {
    const { svc, rows } = build();
    expect(await svc.adoptSourcePoolerAuth('src', 'dst')).toBe(true);
    expect(rows.dst.pooler).toMatchObject({
      authPasswordEnc: 'enc:src-auth',
      adminPasswordEnc: 'enc:src-admin',
      routed: true,
      upstreamClusterIP: '10.43.1.1',
    });
  });

  it('does nothing to a destination without a pooler', async () => {
    const { svc, rows } = build();
    rows.dst.pooler = null;
    expect(await svc.adoptSourcePoolerAuth('src', 'dst')).toBe(false);
    expect(rows.dst.pooler).toBeNull();
  });
});
