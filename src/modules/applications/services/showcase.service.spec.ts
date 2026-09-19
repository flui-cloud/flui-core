// The service's import graph reaches the endpoint service and through it the
// ESM-only Kubernetes client. The suite drives stubs; none of it is constructed.
jest.mock('@kubernetes/client-node', () => ({}));

import { NotFoundException } from '@nestjs/common';
import { ShowcaseService } from './showcase.service';
import { ApplicationEntity } from '../entities/application.entity';
import { ApplicationStatus } from '../enums/application-status.enum';
import { SHOWCASE_TAG } from '../../iam/constants/iam-showcase';

/**
 * The showcase is the one read that crosses from the operator's things to
 * somebody else's screen, so these tests are mostly about what it does *not*
 * carry — and about it reading the same mark the authorization layer reads,
 * because two marks would be free to disagree.
 */

const app = (over: Partial<ApplicationEntity>): ApplicationEntity =>
  ({
    id: 'a1',
    name: 'Umami (showcase)',
    slug: 'umami-29491d',
    kind: 'application',
    status: 'running',
    description: null,
    tags: [],
    clusterId: 'c1',
    k8sNamespace: 'flui-apps',
    env: [{ key: 'DATABASE_URL', value: 'postgres://secret' }],
    createdAt: new Date('2026-08-20T03:36:00Z'),
    ...over,
  }) as unknown as ApplicationEntity;

const build = (
  rows: ApplicationEntity[],
  over: { cluster?: { id: string; name: string; status: string } | null } = {},
) => {
  const store = [...rows];
  const tagged = () =>
    store.filter((r) => (r.tags ?? []).includes(SHOWCASE_TAG));
  const wheres: Array<{ clause: string; params: Record<string, unknown> }> = [];

  const repo = {
    // The real read is a jsonb containment query on `tags`. The stub answers
    // the same question, and records the clause so a test can pin the one part
    // a stub cannot answer for: what is actually bound to the parameter.
    createQueryBuilder: () => {
      const qb: Record<string, unknown> = {};
      const self = () => qb;
      Object.assign(qb, {
        where: (clause: string, params: Record<string, unknown>) => {
          wheres.push({ clause, params });
          return qb;
        },
        orderBy: self,
        getMany: async () => tagged(),
      });
      return qb;
    },
    find: async (opts?: { where?: Record<string, unknown> }) =>
      store.filter((r) => r.name === opts?.where?.name),
    findOne: async ({ where }: { where: Record<string, string> }) =>
      store.find((r) =>
        Object.entries(where).every(
          (pair) =>
            (r as unknown as Record<string, unknown>)[pair[0]] === pair[1],
        ),
      ) ?? null,
    save: async (row: ApplicationEntity) => row,
  };
  const endpoints = {
    mapPrimaryEndpoints: async () =>
      new Map([['a1', { fqdn: 'umami.control-cluster.dawit.blog' }]]),
  };
  const clusters = {
    // `in`, not `??`: an explicit null means "no such cluster", which is the
    // case under test, and `??` would have swallowed it into the default.
    findOne: async () =>
      'cluster' in over
        ? over.cluster
        : { id: 'c1', name: 'demo', status: 'ready' },
  };

  return {
    store,
    wheres,
    service: new ShowcaseService(
      repo as never,
      clusters as never,
      endpoints as never,
    ),
  };
};

describe('ShowcaseService', () => {
  /**
   * A JS array binds as a Postgres array literal, which `@>` against a jsonb
   * column refuses with `invalid input syntax for type json` — so the read that
   * follows a successful write fails, and publishing reports an error on an
   * application it has just published.
   *
   * No stub can catch that by answering the question correctly, so this pins
   * the wire shape instead: JSON text, and a cast that says what it is.
   */
  it('asks Postgres for containment in JSON, not in an array literal', async () => {
    const { service, wheres } = build([app({ tags: [SHOWCASE_TAG] })]);
    await service.list();

    expect(wheres).toHaveLength(1);
    expect(wheres[0].clause).toContain('::jsonb');
    expect(Object.values(wheres[0].params)).toEqual([
      JSON.stringify([SHOWCASE_TAG]),
    ]);
  });

  it('is empty until an application carries the tag', async () => {
    const { service } = build([app({})]);
    await expect(service.list()).resolves.toEqual([]);
  });

  it('carries what the showcase claims, and nothing an application record has', async () => {
    const { service } = build([
      app({ tags: [SHOWCASE_TAG], description: 'Measures flui.cloud.' }),
    ]);

    const [item] = await service.list();

    expect(item.name).toBe('Umami (showcase)');
    expect(item.note).toBe('Measures flui.cloud.');
    expect(item.runningSince).toEqual(new Date('2026-08-20T03:36:00Z'));
    expect(item.url).toBe('https://umami.control-cluster.dawit.blog');
    // The shape is fixed on purpose: no env, no namespace, no cluster, no tags.
    expect(Object.keys(item).sort((a, b) => a.localeCompare(b))).toEqual([
      'id',
      'kind',
      'name',
      'note',
      'runningSince',
      'slug',
      'status',
      'url',
    ]);
  });

  // The tag is what the showcase grant selects on. Publishing through anything
  // else would be a second mark, free to disagree with the one authorization
  // reads.
  it('publishes by adding the same tag the grant follows', async () => {
    const { service, store } = build([app({ tags: ['demo'] })]);

    await service.publish('a1', 'Measures flui.cloud.');

    expect(store[0].tags).toEqual(['demo', SHOWCASE_TAG]);
    expect(store[0].description).toBe('Measures flui.cloud.');
  });

  it('does not tag it twice, and leaves the line alone when none is given', async () => {
    const { service, store } = build([
      app({ tags: [SHOWCASE_TAG], description: 'Already said.' }),
    ]);

    await service.publish('a1');

    expect(store[0].tags).toEqual([SHOWCASE_TAG]);
    expect(store[0].description).toBe('Already said.');
  });

  /**
   * The rule the whole showcase rests on, and the only one that can be enforced
   * in code: nothing enters it that is not actually running. Everything else in
   * §7 is an operational promise — real traffic, a real alarm, weeks of real
   * history — and none of that can be checked from here. This can.
   */
  it('refuses to put something in the window that is not running', async () => {
    const { service, store } = build([
      app({ status: ApplicationStatus.FAILED, tags: [] }),
    ]);

    await expect(service.publish('a1')).rejects.toThrow(/not running/);
    expect(store[0].tags).toEqual([]);
    await expect(service.list()).resolves.toEqual([]);
  });

  // Every state on the way to working, and on the way out of it, is refused:
  // a showcase that took `provisioning` could be filled with things that never
  // came up.
  it.each([
    ApplicationStatus.PENDING,
    ApplicationStatus.PROVISIONING,
    ApplicationStatus.UPDATING,
    ApplicationStatus.DEGRADED,
    ApplicationStatus.STOPPED,
  ])('refuses %s too', async (status) => {
    const { service } = build([app({ status })]);
    await expect(service.publish('a1')).rejects.toThrow(/not running/);
  });

  /**
   * The gate is on the way in only. Something that fails *after* it was
   * published stays, showing the status it really has — a real failure on a
   * real instance is the truth, and hiding it would be the dishonest half of
   * the same rule.
   */
  it('keeps what has already failed, and still lets its line be corrected', async () => {
    const { service, store } = build([
      app({
        status: ApplicationStatus.FAILED,
        tags: [SHOWCASE_TAG],
        description: 'old line',
      }),
    ]);

    await expect(service.publish('a1', 'new line')).resolves.toMatchObject({
      status: 'failed',
    });
    expect(store[0].description).toBe('new line');
  });

  it('leaves the application running when it is withdrawn', async () => {
    const { service, store } = build([
      app({ tags: [SHOWCASE_TAG, 'demo'], description: 'note' }),
    ]);

    await service.withdraw('a1');

    expect(store[0].tags).toEqual(['demo']);
    expect(store[0].status).toBe('running');
    await expect(service.list()).resolves.toEqual([]);
  });

  it('refuses to guess when a name means several applications', async () => {
    const { service } = build([
      app({ id: 'a1', slug: 's1', name: 'Postgres' }),
      app({ id: 'a2', slug: 's2', name: 'Postgres' }),
    ]);

    await expect(service.resolve('Postgres')).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.resolve('s2')).resolves.toMatchObject({ id: 'a2' });
  });

  /**
   * `status` is whatever the last reconciler wrote before the cluster went
   * away, and there is nobody left to correct it — so the running check cannot
   * catch this on its own.
   */
  it('refuses an application whose cluster has been deleted, whatever its row says', async () => {
    const { service } = build(
      [app({ id: 'ghost', status: ApplicationStatus.RUNNING })],
      {
        cluster: { id: 'c1', name: 'demo', status: 'deleted' },
      },
    );

    await expect(service.publish('ghost')).rejects.toThrow(
      /not running anywhere/,
    );
  });

  it('refuses one whose cluster is not registered at all', async () => {
    const { service } = build(
      [app({ id: 'ghost', status: ApplicationStatus.RUNNING })],
      {
        cluster: null,
      },
    );

    await expect(service.publish('ghost')).rejects.toThrow(
      /no longer registered/,
    );
  });
});
