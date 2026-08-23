import { AccessDeltaService } from './access-delta.service';
import { PolicyEngineService } from './policy-engine.service';
import { IamRoleBindingEntity } from '../entities/iam-role-binding.entity';
import { IAM_ROLE } from '../constants/iam-roles';
import { IAM_PERMISSION } from '../constants/iam-permissions';

/**
 * The warning about what somebody stops being able to reach.
 *
 * Two claims are worth pinning here, and they are the ones a screen could get
 * wrong without anybody noticing:
 *
 *  1. an empty list of applications means three different things — nothing was
 *     lost, a snapshot happens to be empty, or the inventory could not be read —
 *     and `coverage` is the only field that tells them apart;
 *  2. the delta is computed against the *engine*, both before and after, so it
 *     cannot promise a boundary the enforcement does not draw.
 */

type Row = Pick<
  IamRoleBindingEntity,
  | 'id'
  | 'principalType'
  | 'principalRef'
  | 'role'
  | 'scopeType'
  | 'scopeRef'
  | 'selector'
>;

const ALICE = 'alice@acme.com';

function binding(over: Partial<Row> = {}): Row {
  return {
    id: 'g1',
    principalType: 'user',
    principalRef: ALICE,
    role: IAM_ROLE.EDITOR,
    scopeType: 'global',
    scopeRef: null,
    selector: null,
    ...over,
  } as Row;
}

const APPS = [
  {
    id: 'a1',
    name: 'Acme API',
    slug: 'acme-api',
    category: 'user',
    kind: 'WEB',
    clusterId: 'c1',
    cluster: { name: 'prod', provider: 'hetzner' },
    project: { slug: 'frontend' },
    tags: [],
    userId: null,
  },
  {
    id: 'a2',
    name: 'Acme DB',
    slug: 'acme-db',
    category: 'user',
    kind: 'DATABASE',
    clusterId: 'c2',
    cluster: { name: 'staging', provider: 'hetzner' },
    project: { slug: 'backend' },
    tags: [],
    userId: null,
  },
];

function build(
  rows: Row[],
  opts: { user?: Record<string, unknown> | null; appsThrow?: boolean } = {},
) {
  const bindingsRepo = {
    createQueryBuilder: () => {
      const qb: Record<string, unknown> = {};
      qb.where = () => qb;
      qb.orWhere = () => qb;
      qb.getMany = async () => rows;
      return qb;
    },
    find: async () => rows,
    findOne: async ({ where }: { where: { id: string } }) =>
      rows.find((r) => r.id === where.id) ?? null,
  };
  const groupsRepo = { find: async () => [] };
  const engine = new PolicyEngineService(
    bindingsRepo as never,
    groupsRepo as never,
  );
  const appsRepo = {
    find: async () => {
      if (opts.appsThrow) throw new Error('cluster database unreachable');
      return APPS;
    },
  };
  const usersRepo = {
    findOne: async () =>
      opts.user === undefined
        ? { id: 'u1', email: ALICE, role: 'user', isAdmin: false }
        : opts.user,
  };
  return new AccessDeltaService(
    bindingsRepo as never,
    appsRepo as never,
    usersRepo as never,
    engine,
  );
}

describe('the delta on a revocation', () => {
  it('names the applications the holder stops being able to read', async () => {
    const service = build([binding()]);
    const delta = await service.previewRevocation('g1');

    expect(delta.applicationsLostCount).toBe(2);
    expect(delta.applicationsLost.map((a) => a.slug)).toEqual([
      'acme-api',
      'acme-db',
    ]);
    expect(delta.losesNothing).toBe(false);
    expect(delta.losesEverything).toBe(true);
  });

  it('closes the sections the role was opening', async () => {
    const service = build([binding({ role: IAM_ROLE.MANAGER })]);
    const delta = await service.previewRevocation('g1');

    expect(new Set(delta.sectionsClosed.map((s) => s.key))).toEqual(
      new Set([
        'access',
        'backup',
        'clusters',
        'deploy',
        'firewall',
        'infrastructure',
        'mail',
        'projects',
        'providers',
        'workloads',
      ]),
    );
    // Home and Settings are gated `always`: nobody ever loses them, and a
    // warning that claimed otherwise would be false.
    expect(delta.sectionsClosed.map((s) => s.key)).not.toContain('home');
    expect(delta.permissionsLost).toContain(IAM_PERMISSION.IAM_ASSIGN_ROLE);
  });

  /**
   * The distinction the whole DTO turns on. A grant that names slugs reaches a
   * list; every other scope reaches a *predicate*, and the applications that
   * match it tomorrow are lost too.
   */
  it('says the list is exact only when the scope named the applications', async () => {
    const named = build([
      binding({
        scopeType: 'selector',
        selector: { slugs: ['acme-api'] },
      }),
    ]);
    expect((await named.previewRevocation('g1')).coverage).toBe('exact');

    const predicate = build([
      binding({ scopeType: 'selector', selector: { kind: 'DATABASE' } }),
    ]);
    const snapshot = await predicate.previewRevocation('g1');
    expect(snapshot.coverage).toBe('snapshot');
    expect(snapshot.applicationsLost.map((a) => a.slug)).toEqual(['acme-db']);
    expect(snapshot.summary).toContain('from now on');
  });

  /** A section-scoped grant reaches no application, so it never blurs the count. */
  it('keeps a section-scoped grant from making the answer a snapshot', async () => {
    const service = build([
      binding({ scopeType: 'section', scopeRef: 'clusters' }),
    ]);
    const delta = await service.previewRevocation('g1');
    expect(delta.coverage).toBe('exact');
    expect(delta.applicationsLostCount).toBe(0);
  });

  /**
   * An empty list because nothing was lost and an empty list because nothing
   * could be read are not the same sentence — the failure giro I named on
   * `volumesKnown`, in its structural form.
   */
  it('refuses to call an unreadable inventory an empty one', async () => {
    const service = build([binding()], { appsThrow: true });
    const delta = await service.previewRevocation('g1');

    expect(delta.coverage).toBe('unknown');
    expect(delta.applicationsLost).toEqual([]);
    expect(delta.applicationsLostCount).toBe(0);
    expect(delta.note).toContain('could not be read');
    expect(delta.summary).toContain('not known');
    // And it must never read as "this is safe, nothing goes".
    expect(delta.summary).not.toMatch(/loses nothing/);
  });

  it('says plainly when a change only adds', async () => {
    const service = build([]);
    const delta = await service.preview({
      principalType: 'user',
      principalRef: ALICE,
      add: [{ role: IAM_ROLE.VIEWER, scopeType: 'global' }],
    });

    expect(delta.losesNothing).toBe(true);
    expect(delta.applicationsGainedCount).toBe(2);
    expect(delta.summary).toContain('loses nothing');
    expect(delta.permissionsGained).toContain(IAM_PERMISSION.APP_READ);
  });

  /**
   * Changing a role is one change, not two. Asked as a removal and an addition
   * separately, the screen would report losing everything and then gaining most
   * of it back — which is true of neither half and false of the whole.
   */
  it('reads a role change as one change', async () => {
    const service = build([binding({ role: IAM_ROLE.MANAGER })]);
    const delta = await service.preview({
      principalType: 'user',
      principalRef: ALICE,
      removeGrantIds: ['g1'],
      add: [{ role: IAM_ROLE.VIEWER, scopeType: 'global' }],
    });

    expect(delta.applicationsLostCount).toBe(0);
    expect(delta.losesEverything).toBe(false);
    expect(delta.permissionsLost).toContain(IAM_PERMISSION.APP_WRITE);
    expect(delta.permissionsLost).toContain(IAM_PERMISSION.IAM_ASSIGN_ROLE);
    expect(delta.sectionsClosed.map((s) => s.key)).toContain('access');
    expect(delta.sectionsClosed.map((s) => s.key)).not.toContain('workloads');
  });

  /**
   * The platform-admin boolean is outside the grant graph, so a warning that
   * counted grants would tell somebody they had lost access they still have.
   */
  it('says a platform admin loses nothing by this, because they do not', async () => {
    const service = build([binding()], {
      user: { id: 'u1', email: ALICE, role: 'admin', isAdmin: true },
    });
    const delta = await service.previewRevocation('g1');

    expect(delta.principalIsPlatformAdmin).toBe(true);
    expect(delta.applicationsLostCount).toBe(0);
    expect(delta.summary).toContain('platform admin');
  });
});
