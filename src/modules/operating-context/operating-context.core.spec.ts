import {
  Placement,
  asSelector,
  covers,
  intersects,
  mayWriteAt,
  needsPlacements,
  reachesFrom,
  reachesReader,
} from './operating-context.core';
import {
  IamSelector,
  PrincipalAccess,
  ScopedGrant,
} from '../iam/interfaces/iam.types';
import { IAM_PERMISSION } from '../iam/constants/iam-permissions';

const READ = IAM_PERMISSION.APP_READ;
const WRITE = IAM_PERMISSION.APP_WRITE;

const grant = (g: Partial<ScopedGrant>): ScopedGrant => ({
  permissions: new Set([READ, WRITE]),
  scopeType: 'selector',
  scopeRef: null,
  selector: null,
  ...g,
});

const access = (
  grants: ScopedGrant[],
  extra: Partial<PrincipalAccess> = {},
): PrincipalAccess => ({
  isAdmin: false,
  globalPermissions: new Set<string>(),
  scopedGrants: grants,
  isSandbox: false,
  ...extra,
});

describe('the three scopes collapse onto one vocabulary', () => {
  it('reads global as the selector that constrains nothing', () => {
    expect(asSelector({ scopeType: 'global' })).toEqual({});
  });

  it('reads a cluster scope as a selector on that cluster', () => {
    expect(asSelector({ scopeType: 'cluster', scopeRef: 'c1' })).toEqual({
      clusterId: 'c1',
    });
  });
});

describe('covers — the relation that must under-approximate', () => {
  it('lets the empty selector cover everything', () => {
    expect(covers({}, { clusterId: 'c1', slugs: ['shop'] })).toBe(true);
  });

  it('refuses a cluster grant over an unconstrained entry', () => {
    expect(covers({ clusterId: 'c1' }, {})).toBe(false);
  });

  it('covers a selector that is narrower on every axis it constrains', () => {
    expect(covers({ clusterId: 'c1' }, { clusterId: 'c1', owner: 'u1' })).toBe(
      true,
    );
  });

  it('refuses when the inner selector says nothing about a constrained axis', () => {
    expect(covers({ owner: 'u1' }, { clusterId: 'c1' })).toBe(false);
  });

  it('covers a slug list only when the inner one is a subset', () => {
    expect(covers({ slugs: ['a', 'b'] }, { slugs: ['a'] })).toBe(true);
    expect(covers({ slugs: ['a'] }, { slugs: ['a', 'b'] })).toBe(false);
    expect(covers({ slugs: ['a'] }, {})).toBe(false);
  });

  it('covers on tags only when the inner one carries all of them', () => {
    expect(covers({ tags: ['prod'] }, { tags: ['prod', 'eu'] })).toBe(true);
    expect(covers({ tags: ['prod'] }, { tags: ['eu'] })).toBe(false);
  });
});

describe('intersects — the relation that must over-approximate', () => {
  it('says a cluster grant meets a global entry', () => {
    expect(intersects({ clusterId: 'c1' }, {})).toBe(true);
  });

  it('says two different clusters never meet', () => {
    expect(intersects({ clusterId: 'c1' }, { clusterId: 'c2' })).toBe(false);
  });

  it('never lets tags block, because a resource may carry any', () => {
    expect(intersects({ tags: ['prod'] }, { tags: ['staging'] })).toBe(true);
  });

  it('lets disjoint slug lists block', () => {
    expect(intersects({ slugs: ['a'] }, { slugs: ['b'] })).toBe(false);
  });
});

/**
 * The half of the feature that has to stay red: advice that reaches somebody it
 * was not written for is worse than no advice, because it describes an
 * installation they cannot see.
 */
describe('what a tenant does not reach', () => {
  const tenant = access([grant({ selector: { owner: 'u1' } })]);

  it('never reads the reasons behind the whole platform', () => {
    expect(
      reachesReader(tenant, {
        scope: { scopeType: 'global' },
        nature: 'rationale',
        permission: READ,
      }),
    ).toBe(false);
  });

  it('never reads the reasons behind a cluster it only has an app on', () => {
    expect(
      reachesReader(tenant, {
        scope: { scopeType: 'cluster', scopeRef: 'c1' },
        nature: 'rationale',
        permission: READ,
      }),
    ).toBe(false);
  });

  it('never reads another tenant’s notes at all', () => {
    for (const nature of ['practice', 'rationale'] as const) {
      expect(
        reachesReader(tenant, {
          scope: { scopeType: 'selector', selector: { owner: 'u2' } },
          nature,
          permission: READ,
        }),
      ).toBe(false);
    }
  });

  it('reaches nothing at all without the read permission', () => {
    const blind = access([
      grant({ selector: { owner: 'u1' }, permissions: new Set([WRITE]) }),
    ]);
    expect(
      reachesReader(blind, {
        scope: { scopeType: 'selector', selector: { owner: 'u1' } },
        nature: 'practice',
        permission: READ,
      }),
    ).toBe(false);
  });
});

/**
 * The other half, and the one this feature is ruined by getting wrong: made
 * narrow enough, it advises nobody. Rule 2 — the *how* descends to whoever acts
 * here — is what these rows are.
 */
describe('what the advice must still reach', () => {
  const tenant = access([grant({ selector: { owner: 'u1' } })]);

  it('gives a tenant the platform’s own practice', () => {
    expect(
      reachesReader(tenant, {
        scope: { scopeType: 'global' },
        nature: 'practice',
        permission: READ,
      }),
    ).toBe(true);
  });

  it('gives a tenant the practice of a cluster they may be on', () => {
    expect(
      reachesReader(tenant, {
        scope: { scopeType: 'cluster', scopeRef: 'c1' },
        nature: 'practice',
        permission: READ,
      }),
    ).toBe(true);
  });

  it('gives a tenant the reasons behind their own applications', () => {
    expect(
      reachesReader(tenant, {
        scope: { scopeType: 'selector', selector: { owner: 'u1' } },
        nature: 'rationale',
        permission: READ,
      }),
    ).toBe(true);
  });

  it('withholds a cluster’s practice from a tenant pinned to another cluster', () => {
    const elsewhere = access([
      grant({ selector: { owner: 'u1', clusterId: 'c2' } }),
    ]);
    expect(
      reachesReader(elsewhere, {
        scope: { scopeType: 'cluster', scopeRef: 'c1' },
        nature: 'practice',
        permission: READ,
      }),
    ).toBe(false);
  });

  it('gives an operator holding the instance everything', () => {
    const global = access([], { globalPermissions: new Set([READ]) });
    expect(
      reachesReader(global, {
        scope: { scopeType: 'selector', selector: { owner: 'u9' } },
        nature: 'rationale',
        permission: READ,
      }),
    ).toBe(true);
  });
});

describe('writing is covering, whatever the nature', () => {
  const tenant = access([grant({ selector: { owner: 'u1' } })]);

  it('lets a tenant annotate their own applications', () => {
    expect(
      mayWriteAt(
        tenant,
        { scopeType: 'selector', selector: { owner: 'u1' } },
        WRITE,
      ),
    ).toBe(true);
  });

  it('refuses a tenant the cluster’s rule', () => {
    expect(
      mayWriteAt(tenant, { scopeType: 'cluster', scopeRef: 'c1' }, WRITE),
    ).toBe(false);
  });

  it('refuses a tenant the platform’s rule', () => {
    expect(mayWriteAt(tenant, { scopeType: 'global' }, WRITE)).toBe(false);
  });

  it('refuses a reader who may act but not change', () => {
    const viewer = access([
      grant({ selector: { owner: 'u1' }, permissions: new Set([READ]) }),
    ]);
    expect(
      mayWriteAt(
        viewer,
        { scopeType: 'selector', selector: { owner: 'u1' } },
        WRITE,
      ),
    ).toBe(false);
  });

  /**
   * "Nella demo l'ospite legge e non scrive." Written on the access rather than
   * on the route, because a guest reaches these notes through their own
   * credential on any surface at all.
   */
  it('refuses a sandbox guest everywhere, including their own things', () => {
    const guest = access([grant({ selector: { owner: 'u1' } })], {
      isSandbox: true,
    });
    expect(
      mayWriteAt(
        guest,
        { scopeType: 'selector', selector: { owner: 'u1' } },
        WRITE,
      ),
    ).toBe(false);
    expect(
      reachesReader(guest, {
        scope: { scopeType: 'global' },
        nature: 'practice',
        permission: READ,
      }),
    ).toBe(true);
  });
});

/**
 * The measured hole (decision 149), and the shape of the repair.
 *
 * `intersects` discards an axis only when both sides declare it and disagree,
 * so a grant naming only its owner leaves the cluster axis open and meets every
 * cluster there is. On an installation with more than one cluster that hands a
 * tenant the local practice of clusters they have nothing on. The relation is
 * left exactly as it was — it over-approximates on purpose — and what is
 * narrowed is the question put to it.
 */
describe('a grant that says who, not where', () => {
  const tenant: IamSelector = { owner: 'u1' };
  const onC1: Placement[] = [
    { clusterId: 'c1', clusterName: 'prod', provider: 'hetzner' },
  ];

  it('meets every cluster while nobody has located its resources', () => {
    expect(intersects(tenant, { clusterId: 'c2' })).toBe(true);
    expect(reachesFrom(tenant, { clusterId: 'c2' }, null)).toBe(true);
  });

  it('stops at the clusters its resources actually sit on', () => {
    expect(reachesFrom(tenant, { clusterId: 'c1' }, onC1)).toBe(true);
    expect(reachesFrom(tenant, { clusterId: 'c2' }, onC1)).toBe(false);
  });

  it('narrows on the cluster’s name and its provider too', () => {
    expect(reachesFrom(tenant, { clusterName: 'prod' }, onC1)).toBe(true);
    expect(reachesFrom(tenant, { clusterName: 'staging' }, onC1)).toBe(false);
    expect(reachesFrom(tenant, { provider: 'scaleway' }, onC1)).toBe(false);
  });

  /** Rule 2, and the reversion that would make the whole feature pointless. */
  it('never touches an entry that names no place', () => {
    expect(reachesFrom(tenant, {}, [])).toBe(true);
    expect(reachesFrom(tenant, {}, onC1)).toBe(true);
  });

  it('withholds every cluster’s practice from a tenant who has nothing yet', () => {
    expect(reachesFrom(tenant, { clusterId: 'c1' }, [])).toBe(false);
    expect(reachesFrom(tenant, {}, [])).toBe(true);
  });

  /**
   * The direction that has to stay safe: not having asked is not the same as
   * not knowing, but not knowing still widens.
   */
  it('goes back to over-approximating when the placements are unknown', () => {
    expect(reachesFrom(tenant, { clusterId: 'c2' })).toBe(true);
  });

  /**
   * An operator of a cluster with nothing on it yet is exactly the person the
   * cluster's own practice is for.
   */
  it('leaves a grant that already names its cluster alone', () => {
    expect(reachesFrom({ clusterId: 'c1' }, { clusterId: 'c1' }, [])).toBe(
      true,
    );
    expect(reachesFrom({ clusterId: 'c1' }, { clusterId: 'c2' }, [])).toBe(
      false,
    );
  });

  it('leaves a grant that constrains nothing alone', () => {
    expect(reachesFrom({}, { clusterId: 'c9' }, [])).toBe(true);
  });

  it('narrows a grant that follows slugs or tags, not only an owner', () => {
    expect(reachesFrom({ slugs: ['shop'] }, { clusterId: 'c2' }, onC1)).toBe(
      false,
    );
    expect(reachesFrom({ tags: ['prod'] }, { clusterId: 'c2' }, onC1)).toBe(
      false,
    );
  });
});

describe('reading a note, with the reader located', () => {
  const tenant = access([grant({ selector: { owner: 'u1' } })]);
  const onC1: Placement[] = [{ clusterId: 'c1' }];

  const practiceOn = (clusterId: string) => ({
    scope: { scopeType: 'cluster' as const, scopeRef: clusterId },
    nature: 'practice' as const,
    permission: READ,
  });

  it('hands over the practice of the cluster they are on', () => {
    expect(reachesReader(tenant, practiceOn('c1'), onC1)).toBe(true);
  });

  it('withholds the practice of a cluster they have nothing on', () => {
    expect(reachesReader(tenant, practiceOn('c2'), onC1)).toBe(false);
  });

  it('still hands over the platform’s own practice', () => {
    expect(
      reachesReader(
        tenant,
        {
          scope: { scopeType: 'global' },
          nature: 'practice',
          permission: READ,
        },
        [],
      ),
    ).toBe(true);
  });

  it('changes nothing for a reader who is not located', () => {
    expect(reachesReader(tenant, practiceOn('c2'))).toBe(true);
  });

  it('changes nothing about the reasons, which are covered or refused', () => {
    const why = {
      scope: { scopeType: 'cluster' as const, scopeRef: 'c1' },
      nature: 'rationale' as const,
      permission: READ,
    };
    expect(reachesReader(tenant, why, onC1)).toBe(false);
    expect(reachesReader(tenant, why, null)).toBe(false);
  });
});

/** The query is not run for the readers it could not change the answer for. */
describe('when locating the reader is worth a query', () => {
  const tenant = access([grant({ selector: { owner: 'u1' } })]);
  const placeBound = [{ clusterId: 'c1' }];

  it('is worth it for a grant that says who but not where', () => {
    expect(needsPlacements(tenant, placeBound, READ)).toBe(true);
  });

  it('is not worth it for an administrator', () => {
    expect(
      needsPlacements(access([], { isAdmin: true }), placeBound, READ),
    ).toBe(false);
  });

  it('is not worth it for an instance-wide operator', () => {
    expect(
      needsPlacements(
        access([], { globalPermissions: new Set([READ]) }),
        placeBound,
        READ,
      ),
    ).toBe(false);
  });

  it('is not worth it when no entry names a place', () => {
    expect(needsPlacements(tenant, [{}, { owner: 'u1' }], READ)).toBe(false);
  });

  it('is not worth it for a grant already pinned to a cluster', () => {
    expect(
      needsPlacements(
        access([grant({ selector: { owner: 'u1', clusterId: 'c1' } })]),
        placeBound,
        READ,
      ),
    ).toBe(false);
  });

  it('ignores a grant that does not carry the permission being asked about', () => {
    expect(
      needsPlacements(
        access([
          grant({ selector: { owner: 'u1' }, permissions: new Set([WRITE]) }),
        ]),
        placeBound,
        READ,
      ),
    ).toBe(false);
  });
});
