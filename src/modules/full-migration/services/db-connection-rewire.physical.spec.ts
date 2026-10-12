jest.mock('@kubernetes/client-node', () => ({}));

import { DbConnectionRewireService } from './db-connection-rewire.service';

const enc = {
  encrypt: (v: string) => `enc(${v})`,
  decrypt: (v: string) => v.replace(/^enc\((.*)\)$/, '$1'),
};

function db(
  slug: string,
  ns: string,
  user: string,
  pass: string,
  name: string,
): any {
  return {
    slug,
    k8sNamespace: ns,
    env: [
      { name: 'POSTGRES_USER', value: user },
      { name: 'POSTGRES_PASSWORD', value: enc.encrypt(pass), secret: true },
      { name: 'POSTGRES_DB', value: name },
    ],
  };
}

describe('DbConnectionRewireService with a physical copy', () => {
  const svc = new DbConnectionRewireService({} as any, enc as any);
  const src = db('pg-a', 'p1', 'app', 'src-pass', 'appdb');
  const dst = db('pg-b', 'p1', 'gen-user', 'gen-pass', 'gendb');
  const consumer: any = {
    slug: 'api',
    env: [
      {
        name: 'DATABASE_URL',
        value: enc.encrypt(
          'postgres://app:src-pass@pg-a-svc.p1.svc.cluster.local:5432/appdb',
        ),
        secret: true,
      },
    ],
  };

  it('changes only the host when credentials come from the source', () => {
    const plan = svc.computeRewirePlan(consumer, src, dst, {
      credentialsFrom: src,
    });
    expect(enc.decrypt(plan.env[0].value)).toBe(
      'postgres://app:src-pass@pg-b-svc.p1.svc.cluster.local:5432/appdb',
    );
  });

  it('keeps using the destination install credentials by default', () => {
    const plan = svc.computeRewirePlan(consumer, src, dst);
    expect(enc.decrypt(plan.env[0].value)).toBe(
      'postgres://gen-user:gen-pass@pg-b-svc.p1.svc.cluster.local:5432/gendb',
    );
  });
});

describe('DbConnectionRewireService with a pooled source', () => {
  const svc = new DbConnectionRewireService({} as any, enc as any);
  const pooled = (slug: string, routed = true) => ({
    ...db(slug, 'p1', 'app', 'src-pass', 'appdb'),
    pooler: { enabled: true, routed },
  });
  const src = pooled('pg-a');
  const dst = pooled('pg-b', false);

  it('follows a secret reference to the source URL into the destination Secret, through its pooler', () => {
    const consumer: any = {
      slug: 'api',
      env: [
        {
          name: 'DATABASE_URL',
          value: '',
          externalSecretRef: {
            secretName: 'pg-a-secret',
            key: 'FLUI_CONNECTION_URL',
          },
        },
      ],
    };
    expect(() =>
      svc.computeRewirePlan(consumer, src, dst, { credentialsFrom: src }),
    ).toThrow(/externalSecretRef/);
    const plan = svc.computeRewirePlan(consumer, src, dst, {
      credentialsFrom: src,
      secretRefs: true,
    });
    expect(plan.env[0].externalSecretRef).toEqual({
      secretName: 'pg-b-secret',
      key: 'FLUI_CONNECTION_URL',
    });
    expect(plan.shape).toBe('external-secret-ref');
    expect(plan.viaPooler).toBe(true);
    expect(svc.assertRewirable(consumer, src, { secretRefs: true })).toBe(
      'external-secret-ref',
    );
  });

  it('keeps the direct key direct', () => {
    const consumer: any = {
      slug: 'api',
      env: [
        {
          name: 'MIGRATE_URL',
          value: '',
          externalSecretRef: {
            secretName: 'pg-a-secret',
            key: 'FLUI_DIRECT_URL',
          },
        },
      ],
    };
    const plan = svc.computeRewirePlan(consumer, src, dst, {
      secretRefs: true,
    });
    expect(plan.env[0].externalSecretRef?.secretName).toBe('pg-b-secret');
    expect(plan.viaPooler).toBe(false);
  });

  it('refuses a secret reference to anything but the two URLs', () => {
    const consumer: any = {
      slug: 'api',
      env: [
        {
          name: 'PGPASSWORD',
          value: '',
          externalSecretRef: {
            secretName: 'pg-a-secret',
            key: 'POSTGRES_PASSWORD',
          },
        },
      ],
    };
    expect(() =>
      svc.computeRewirePlan(consumer, src, dst, { secretRefs: true }),
    ).toThrow(/only FLUI_CONNECTION_URL and FLUI_DIRECT_URL/);
  });

  it('moves a literal on the source pooler to the destination pooler, keeping its port', () => {
    const consumer: any = {
      slug: 'api',
      env: [
        {
          name: 'DATABASE_URL',
          value: enc.encrypt(
            'postgres://app:src-pass@pg-a-pooler.p1.svc.cluster.local:6543/appdb?sslmode=disable',
          ),
          secret: true,
        },
        {
          name: 'MIGRATE_URL',
          value:
            'postgres://app:src-pass@pg-a-svc.p1.svc.cluster.local:5433/appdb',
        },
      ],
    };
    const plan = svc.computeRewirePlan(consumer, src, dst, {
      credentialsFrom: src,
    });
    expect(enc.decrypt(plan.env[0].value)).toBe(
      'postgres://app:src-pass@pg-b-pooler.p1.svc.cluster.local:6543/appdb?sslmode=disable',
    );
    expect(plan.env[1].value).toBe(
      'postgres://app:src-pass@pg-b-svc.p1.svc.cluster.local:5433/appdb',
    );
    expect(plan.viaPooler).toBe(true);
  });

  it('moves PGHOST on the source pooler to the destination pooler', () => {
    const consumer: any = {
      slug: 'api',
      env: [
        { name: 'PGHOST', value: 'pg-a-pooler.p1.svc.cluster.local' },
        { name: 'PGPORT', value: '5432' },
      ],
    };
    const plan = svc.computeRewirePlan(consumer, src, dst, {
      credentialsFrom: src,
    });
    expect(plan.env[0].value).toBe('pg-b-pooler.p1.svc.cluster.local');
    expect(plan.env[1].value).toBe('5432');
    expect(plan.viaPooler).toBe(true);
  });

  it('refuses the pooled address when the destination has no pooler', () => {
    const consumer: any = {
      slug: 'api',
      env: [{ name: 'PGHOST', value: 'pg-a-pooler.p1.svc.cluster.local' }],
    };
    expect(() =>
      svc.computeRewirePlan(consumer, src, db('pg-b', 'p1', 'u', 'p', 'd'), {
        credentialsFrom: src,
      }),
    ).toThrow(/destination database has none/);
  });

  it('tells which other applications reach the database, by Secret or by either address', () => {
    const byRef: any = {
      env: [
        {
          name: 'X',
          value: '',
          externalSecretRef: {
            secretName: 'pg-a-secret',
            key: 'FLUI_CONNECTION_URL',
          },
        },
      ],
    };
    const byPooler: any = {
      env: [{ name: 'PGHOST', value: 'pg-a-pooler.p1.svc.cluster.local' }],
    };
    const byShortSvc: any = { env: [{ name: 'PGHOST', value: 'pg-a-svc' }] };
    const unrelated: any = {
      env: [{ name: 'PGHOST', value: 'pg-c-svc.p1.svc.cluster.local' }],
    };
    expect(svc.referencesDb(byRef, src)).toBe(true);
    expect(svc.referencesDb(byPooler, src)).toBe(true);
    expect(svc.referencesDb(byShortSvc, src)).toBe(true);
    expect(svc.referencesDb(unrelated, src)).toBe(false);
  });
});
