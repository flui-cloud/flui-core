import {
  advisable,
  appliesTo,
  conflictsAmong,
  needsReview,
  probeAllowedAt,
  validityOf,
} from './operating-context.validity';
import { PolicyEngineService } from '../iam/services/policy-engine.service';
import {
  IamSelector,
  PrincipalAccess,
  ResourceAttributes,
} from '../iam/interfaces/iam.types';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-25T12:00:00Z');

describe('an entry’s verdict on itself', () => {
  it('calls prose unverified rather than pretending', () => {
    expect(validityOf({ checkKind: 'none' }, NOW)).toBe('unverified');
  });

  it('calls a probe that agrees checked', () => {
    expect(
      validityOf({ checkKind: 'probe', lastProbeStatus: 'holds' }, NOW),
    ).toBe('checked');
  });

  /** The whole reason the feature exists: the entry withdraws itself. */
  it('calls a probe that disagrees broken', () => {
    expect(
      validityOf({ checkKind: 'probe', lastProbeStatus: 'broken' }, NOW),
    ).toBe('broken');
  });

  /**
   * An unavailable comparison is not evidence, and it is certainly not evidence
   * *against*. A probe that cannot run must never make a true rule disappear.
   */
  it('calls a probe that could not answer unverified, never broken', () => {
    expect(
      validityOf({ checkKind: 'probe', lastProbeStatus: 'unknown' }, NOW),
    ).toBe('unverified');
  });

  it('calls a confirmation inside its window checked', () => {
    expect(
      validityOf(
        {
          checkKind: 'attestation',
          confirmedAt: new Date(NOW.getTime() - 10 * DAY),
          validForDays: 90,
        },
        NOW,
      ),
    ).toBe('checked');
  });

  it('calls a lapsed confirmation stale, and never broken', () => {
    expect(
      validityOf(
        {
          checkKind: 'attestation',
          confirmedAt: new Date(NOW.getTime() - 200 * DAY),
          validForDays: 90,
        },
        NOW,
      ),
    ).toBe('stale');
  });

  it('calls an attestation nobody ever signed stale', () => {
    expect(
      validityOf({ checkKind: 'attestation', validForDays: 90 }, NOW),
    ).toBe('stale');
  });
});

describe('what is delivered and what is flagged', () => {
  it('never advises with a broken entry', () => {
    expect(advisable('broken')).toBe(false);
    expect(needsReview('broken')).toBe(true);
  });

  it('still advises with a stale one, and asks for it back', () => {
    expect(advisable('stale')).toBe(true);
    expect(needsReview('stale')).toBe(true);
  });

  it('leaves honest prose alone', () => {
    expect(advisable('unverified')).toBe(true);
    expect(needsReview('unverified')).toBe(false);
  });
});

/** Rule 4, mechanised: a global entry has nothing to be compared with. */
describe('the level a probe is allowed at', () => {
  it('refuses one on a global entry', () => {
    expect(probeAllowedAt({ scopeType: 'global' })).toBe(false);
  });

  it('allows one on a cluster and on a selector', () => {
    expect(probeAllowedAt({ scopeType: 'cluster', scopeRef: 'c1' })).toBe(true);
    expect(probeAllowedAt({ scopeType: 'selector', selector: {} })).toBe(true);
  });
});

describe('conflicts are shown, never resolved', () => {
  const at = (
    id: string,
    topic: string,
    scopeType: string,
    scopeRef?: string,
  ) => ({
    id,
    topic,
    scopeType,
    scopeRef,
  });

  it('names two entries about one topic written at different levels', () => {
    expect(
      conflictsAmong([
        at('a', 'master-scaling', 'global'),
        at('b', 'master-scaling', 'cluster', 'c1'),
        at('c', 'backups', 'global'),
      ]),
    ).toEqual([{ topic: 'master-scaling', entryIds: ['a', 'b'] }]);
  });

  it('is silent about two entries at the same level', () => {
    expect(
      conflictsAmong([
        at('a', 'backups', 'cluster', 'c1'),
        at('b', 'backups', 'cluster', 'c1'),
      ]),
    ).toEqual([]);
  });

  it('picks no winner — the caller gets both ids and asks', () => {
    const [conflict] = conflictsAmong([
      at('platform', 'master-scaling', 'global'),
      at('app', 'master-scaling', 'selector'),
    ]);
    expect(conflict.entryIds).toHaveLength(2);
    expect(Object.keys(conflict)).toEqual(['topic', 'entryIds']);
  });
});

/**
 * The predicate is written twice — once in the engine, once here — and this is
 * what keeps the second copy honest. It compares them on the same inputs
 * through the engine's own public surface rather than reaching into its
 * private method.
 */
describe('“does this entry apply here” answers what the fence answers', () => {
  const engine = new PolicyEngineService(null as never, null as never);

  const throughEngine = (
    selector: IamSelector,
    resource: ResourceAttributes,
  ): boolean => {
    const access: PrincipalAccess = {
      isAdmin: false,
      globalPermissions: new Set<string>(),
      scopedGrants: [
        {
          permissions: new Set(['app:read']),
          scopeType: 'selector',
          scopeRef: null,
          selector,
        },
      ],
      isSandbox: false,
    };
    return engine.can(access, 'app:read', resource);
  };

  const CASES: Array<[IamSelector, ResourceAttributes]> = [
    [{}, { slug: 'shop', clusterId: 'c1' }],
    [{ owner: 'u1' }, { slug: 'shop', owner: 'u1' }],
    [{ owner: 'u1' }, { slug: 'shop', owner: 'u2' }],
    [{ owner: 'u1' }, { slug: 'shop' }],
    [{ clusterId: 'c1' }, { clusterId: 'c1' }],
    [{ clusterId: 'c1' }, { clusterId: 'c2' }],
    [{ slugs: ['a', 'b'] }, { slug: 'b' }],
    [{ slugs: ['a'] }, { slug: 'b' }],
    [{ tags: ['prod'] }, { tags: ['prod', 'eu'] }],
    [{ tags: ['prod'] }, { tags: ['eu'] }],
    [
      { type: 'user', kind: 'APPLICATION' },
      { type: 'user', kind: 'APPLICATION' },
    ],
    [{ project: 'p1' }, { project: 'p2' }],
  ];

  it.each(CASES)('agrees on %j against %j', (selector, resource) => {
    expect(appliesTo({ scopeType: 'selector', selector }, resource)).toBe(
      throughEngine(selector, resource),
    );
  });
});
