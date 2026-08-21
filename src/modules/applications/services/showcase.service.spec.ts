// The service's import graph reaches the endpoint service and through it the
// ESM-only Kubernetes client. The suite drives stubs; none of it is constructed.
jest.mock('@kubernetes/client-node', () => ({}));

import { NotFoundException } from '@nestjs/common';
import { ShowcaseService } from './showcase.service';
import { ApplicationEntity } from '../entities/application.entity';
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

const build = (rows: ApplicationEntity[]) => {
  const store = [...rows];
  const tagged = () =>
    store.filter((r) => (r.tags ?? []).includes(SHOWCASE_TAG));

  const repo = {
    // The real read is a `tags @> ARRAY['showcase']` query builder; the stub
    // answers the same question.
    createQueryBuilder: () => {
      const qb: Record<string, unknown> = {};
      const self = () => qb;
      Object.assign(qb, {
        where: self,
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
  return {
    store,
    service: new ShowcaseService(repo as never, endpoints as never),
  };
};

describe('ShowcaseService', () => {
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
});
