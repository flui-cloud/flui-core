import { ApplicationReaderPlacements } from './application-placements';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { PolicyEngineService } from '../../iam/services/policy-engine.service';
import { PrincipalAccess } from '../../iam/interfaces/iam.types';

const app = (over: Partial<ApplicationEntity>): ApplicationEntity =>
  ({
    id: over.id ?? 'a1',
    slug: 'shop',
    category: 'user',
    kind: 'application',
    clusterId: 'c1',
    userId: null,
    tags: [],
    cluster: { id: 'c1', name: 'prod', provider: 'hetzner' },
    ...over,
  }) as unknown as ApplicationEntity;

const tenant = (owner: string): PrincipalAccess => ({
  isAdmin: false,
  globalPermissions: new Set<string>(),
  scopedGrants: [
    {
      permissions: new Set(['app:read']),
      scopeType: 'selector',
      scopeRef: null,
      selector: { owner },
    },
  ],
  isSandbox: false,
});

/**
 * The real engine, not a stub of it: the point of resolving placements through
 * `can` is that the matching rules live in one place, and a test that mocked
 * the answer would be testing the copy this class exists not to make.
 */
const build = (rows: ApplicationEntity[] | Error) => {
  const apps = {
    find: jest.fn(async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    }),
  };
  const policy = new PolicyEngineService(
    undefined as never,
    undefined as never,
  );
  return new ApplicationReaderPlacements(apps as never, policy);
};

describe('where a principal’s resources actually sit', () => {
  it('reports the cluster of every application they may read', async () => {
    const placements = build([
      app({ id: 'a1', userId: 'u1' }),
      app({
        id: 'a2',
        userId: 'u1',
        clusterId: 'c2',
        cluster: {
          id: 'c2',
          name: 'staging',
          provider: 'scaleway',
        } as ApplicationEntity['cluster'],
      }),
    ]);
    expect(await placements.placementsOf(tenant('u1'), 'app:read')).toEqual([
      { clusterId: 'c1', clusterName: 'prod', provider: 'hetzner' },
      { clusterId: 'c2', clusterName: 'staging', provider: 'scaleway' },
    ]);
  });

  it('leaves out the clusters they only have somebody else’s work on', async () => {
    const placements = build([
      app({ id: 'a1', userId: 'u1' }),
      app({
        id: 'a2',
        userId: 'u2',
        clusterId: 'c2',
        cluster: { id: 'c2', name: 'other' } as ApplicationEntity['cluster'],
      }),
    ]);
    expect(await placements.placementsOf(tenant('u1'), 'app:read')).toEqual([
      { clusterId: 'c1', clusterName: 'prod', provider: 'hetzner' },
    ]);
  });

  it('reports one place per cluster, not one per application', async () => {
    const placements = build([
      app({ id: 'a1', userId: 'u1' }),
      app({ id: 'a2', userId: 'u1', slug: 'blog' }),
    ]);
    expect(
      await placements.placementsOf(tenant('u1'), 'app:read'),
    ).toHaveLength(1);
  });

  /** Nowhere is an answer. It narrows; it is not the same as not knowing. */
  it('says nowhere for a tenant with nothing on the installation', async () => {
    const placements = build([app({ id: 'a1', userId: 'u2' })]);
    expect(await placements.placementsOf(tenant('u1'), 'app:read')).toEqual([]);
  });

  /**
   * The failure has to widen the answer back, never narrow it: an inventory
   * that is briefly unreadable must not quietly stop the local practice from
   * reaching the people it was written for.
   */
  it('says nothing at all — not nowhere — when the inventory cannot be read', async () => {
    const placements = build(new Error('connection terminated'));
    expect(await placements.placementsOf(tenant('u1'), 'app:read')).toBeNull();
  });

  it('never loads a column that holds an application’s secrets', async () => {
    const apps = {
      find: jest.fn(
        async (_options: { select: Record<string, unknown> }) => [],
      ),
    };
    const policy = new PolicyEngineService(
      undefined as never,
      undefined as never,
    );
    await new ApplicationReaderPlacements(apps as never, policy).placementsOf(
      tenant('u1'),
      'app:read',
    );
    const asked = Object.keys(apps.find.mock.calls[0][0].select);
    expect(asked).not.toContain('env');
    expect(asked).not.toContain('sourceConfig');
    expect(asked).toContain('clusterId');
  });
});
