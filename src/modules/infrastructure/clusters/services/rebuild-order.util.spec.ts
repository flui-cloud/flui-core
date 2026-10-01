import {
  OrderableApp,
  orderForRebuild,
  rebuildDependencies,
  waitsFor,
} from './rebuild-order.util';

const app = (over: Partial<OrderableApp> & { id: string }): OrderableApp => ({
  name: over.id,
  slug: over.id,
  kind: 'APPLICATION',
  env: [],
  metadata: {},
  ...over,
});

const names = (apps: OrderableApp[]) => apps.map((a) => a.name);

describe('the order a rebuild brings applications back in', () => {
  it('brings a database back before the application whose variables name it, whatever the names', () => {
    // By name, `api` came first and booted against a database not restored yet.
    const apps = [
      app({
        id: 'api',
        env: [
          {
            name: 'DATABASE_URL',
            value: 'postgres://u:p@zz-postgres.apps.svc.cluster.local:5432/db',
          },
        ],
      }),
      app({ id: 'zz-postgres', kind: 'DATABASE' }),
    ];

    const deps = rebuildDependencies(apps);
    expect(names(orderForRebuild(apps, deps))).toEqual(['zz-postgres', 'api']);
    expect(waitsFor(apps, deps).get('api')).toEqual(['zz-postgres']);
  });

  it('reads the composed form of a component host and a building block Secret', () => {
    const apps = [
      app({
        id: 'a-web',
        env: [{ name: 'CACHE', value: 'stack-redis-svc:6379' }],
      }),
      app({
        id: 'b-worker',
        env: [
          {
            name: 'PGPASSWORD',
            value: '',
            externalSecretRef: { secretName: 'pg-main-credentials', key: 'p' },
          },
        ],
      }),
      app({ id: 'stack-redis' }),
      app({ id: 'pg-main' }),
    ];

    const order = names(orderForRebuild(apps, rebuildDependencies(apps)));
    expect(order.indexOf('stack-redis')).toBeLessThan(order.indexOf('a-web'));
    expect(order.indexOf('pg-main')).toBeLessThan(order.indexOf('b-worker'));
  });

  it('does not read a slug inside a longer name', () => {
    const apps = [
      app({ id: 'a', env: [{ name: 'X', value: 'http://my-db:80 dbx' }] }),
      app({ id: 'db' }),
    ];
    expect(rebuildDependencies(apps)).toEqual([]);
  });

  it('follows an attached building block and a catalog install’s own order', () => {
    const apps = [
      app({ id: 'aa-frontend' }),
      app({ id: 'bb-backend' }),
      app({ id: 'cc-store' }),
      app({ id: 'mm-shop' }),
      app({ id: 'zz-pg' }),
    ];
    const deps = rebuildDependencies(
      apps,
      [
        // Created dependencies first by the install itself.
        { id: 'i1', applicationIds: ['cc-store', 'bb-backend', 'aa-frontend'] },
      ],
      [{ applicationId: 'mm-shop', bbApplicationId: 'zz-pg' }],
    );

    const order = names(orderForRebuild(apps, deps));
    expect(order.indexOf('cc-store')).toBeLessThan(order.indexOf('bb-backend'));
    expect(order.indexOf('bb-backend')).toBeLessThan(
      order.indexOf('aa-frontend'),
    );
    expect(order.indexOf('zz-pg')).toBeLessThan(order.indexOf('mm-shop'));
  });

  it('puts every application of an install after the install it depends on', () => {
    const apps = [app({ id: 'app-x' }), app({ id: 'z-db' })];
    const deps = rebuildDependencies(apps, [
      { id: 'app', applicationIds: ['app-x'], dependencyInstallIds: ['db'] },
      { id: 'db', applicationIds: ['z-db'] },
    ]);
    expect(names(orderForRebuild(apps, deps))).toEqual(['z-db', 'app-x']);
  });

  it('ignores what is not being rebuilt', () => {
    const apps = [app({ id: 'a' })];
    expect(
      rebuildDependencies(
        apps,
        [],
        [{ applicationId: 'a', bbApplicationId: 'elsewhere' }],
      ),
    ).toEqual([]);
  });

  it('falls back to databases first, then by name, when nothing is stated', () => {
    const apps = [
      app({ id: 'b' }),
      app({ id: 'z', kind: 'DATABASE' }),
      app({ id: 'a' }),
    ];
    expect(names(orderForRebuild(apps, []))).toEqual(['z', 'a', 'b']);
  });

  it('still orders every application when two name each other', () => {
    const apps = [
      app({ id: 'one', env: [{ name: 'P', value: 'two:1' }] }),
      app({ id: 'two', env: [{ name: 'P', value: 'one:1' }] }),
      app({ id: 'three' }),
    ];
    const ordered = orderForRebuild(apps, rebuildDependencies(apps));
    expect(ordered).toHaveLength(3);
    expect(new Set(names(ordered))).toEqual(new Set(['one', 'two', 'three']));
  });
});
