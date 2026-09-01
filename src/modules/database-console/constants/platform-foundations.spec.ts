import { NotFoundException } from '@nestjs/common';
import {
  assertNotPlatformFoundation,
  CONSOLE_TARGET_ABSENT,
  FOUNDATION_REACH,
  FoundationCandidate,
  foundationReachOf,
  PLATFORM_FOUNDATIONS,
  platformFoundationAtTarget,
  platformFoundationOf,
} from './platform-foundations';

const row = (over: Partial<FoundationCandidate>): FoundationCandidate => ({
  slug: 'app-7f3a91',
  name: 'Something',
  k8sNamespace: 'user-dawit',
  labels: {},
  ...over,
});

/**
 * The list as a contract. It is the one place the platform's foundations are
 * named, so these tests are what turns "we decided they are closed" into
 * something that cannot be undone by accident.
 */
describe('the declared foundations', () => {
  it('names the platform database and the identity provider, and nothing less', () => {
    const keys = PLATFORM_FOUNDATIONS.map((f) => f.key);
    expect(keys).toContain('platform-postgres');
    expect(keys).toContain('identity-provider');
  });

  it('is never empty — an emptied list is an opened product', () => {
    expect(PLATFORM_FOUNDATIONS.length).toBeGreaterThanOrEqual(2);
  });

  it('carries the reason next to every entry, so removing one removes its reason', () => {
    for (const foundation of PLATFORM_FOUNDATIONS) {
      expect(foundation.why.trim().length).toBeGreaterThan(40);
      expect(foundation.names.length).toBeGreaterThan(0);
      expect(foundation.namespaces.length).toBeGreaterThan(0);
      expect(foundation.ports.length).toBeGreaterThan(0);
    }
  });

  it('closes every name and every port it declares', () => {
    for (const foundation of PLATFORM_FOUNDATIONS) {
      for (const name of foundation.names) {
        expect(platformFoundationOf(row({ slug: name }))).toBe(foundation);
      }
      for (const namespace of foundation.namespaces) {
        for (const port of foundation.ports) {
          expect(platformFoundationAtTarget(namespace, port)).not.toBeNull();
        }
      }
    }
  });
});

/**
 * An application is identified three ways today — a slug, a namespace, an id —
 * and each of them can change. A closure hung on one of them comes unhooked the
 * day that one moves, which is why each hook is proved on its own here, with
 * the other two deliberately wrong.
 */
describe('what the fence is anchored to', () => {
  it('closes on the name alone, wherever the thing has been moved to', () => {
    expect(
      platformFoundationOf(
        row({ slug: 'postgres', k8sNamespace: 'somewhere-else', labels: {} }),
      )?.key,
    ).toBe('platform-postgres');
    expect(
      platformFoundationOf(
        row({
          slug: 'renamed-7c21',
          labels: { app: 'zitadel' },
          k8sNamespace: 'flui-observability',
        }),
      )?.key,
    ).toBe('identity-provider');
  });

  it('closes on where it sits plus what it is called, after a rename', () => {
    expect(
      platformFoundationOf(
        row({
          slug: 'pg-primary-01',
          name: 'PostgreSQL (platform)',
          k8sNamespace: 'flui-system',
          labels: {},
        }),
      )?.key,
    ).toBe('platform-postgres');
  });

  it('closes on the port alone, when the row has lost every name it had', () => {
    expect(platformFoundationAtTarget('flui-system', 5432)?.key).toBe(
      'platform-postgres',
    );
  });

  it('is not anchored on the id, which is coined per installation', () => {
    // Nothing here names an id, and nothing may: the uuids differ on every
    // instance, so a list of them would be empty exactly where it is needed.
    const asJson = JSON.stringify(PLATFORM_FOUNDATIONS);
    expect(asJson).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it('does not lean on the engine declaration, which the bootstrap never writes', () => {
    // The accidental immunity we have today: no `flui.cloud/db-engine`, so the
    // console answers "unrecognized engine". The fence must not need it.
    expect(
      platformFoundationOf(
        row({ slug: 'postgres', k8sNamespace: 'flui-system', labels: {} }),
      ),
    ).not.toBeNull();
  });

  it('does not lean on recorded provenance either', () => {
    // Nothing about owner-kind, owner-id or a null userId is read: that work is
    // in flight elsewhere and the closure must hold whatever shape it takes.
    expect(
      platformFoundationOf({
        slug: 'zitadel',
        k8sNamespace: 'flui-system',
      } as FoundationCandidate),
    ).not.toBeNull();
  });
});

/**
 * The other half: a fence that closes everything is not a fence, it is an
 * outage. The system apps that are ordinary risk stay open, and so does a
 * tenant's own database however it is named.
 */
describe('what the fence leaves open', () => {
  it.each([
    ['redis', 'flui-system'],
    ['grafana', 'flui-control'],
    ['loki', 'flui-control'],
    ['vmsingle', 'flui-control'],
    ['vmagent', 'flui-control'],
    ['flui-api', 'flui-system'],
  ])('leaves the ordinary system app %s open', (slug, namespace) => {
    expect(
      platformFoundationOf(
        row({
          slug,
          name: slug,
          k8sNamespace: namespace,
          labels: { app: slug },
        }),
      ),
    ).toBeNull();
  });

  it("leaves a tenant's own Postgres open, name and all", () => {
    expect(
      platformFoundationOf(
        row({
          slug: 'postgres-815796',
          name: 'Postgres',
          k8sNamespace: 'user-dawit',
          labels: { 'flui.cloud/db-engine': 'postgres' },
        }),
      ),
    ).toBeNull();
  });

  it('leaves the cache port in a platform namespace open', () => {
    expect(platformFoundationAtTarget('flui-system', 6379)).toBeNull();
  });

  it("leaves a tenant's namespace open on the same port", () => {
    expect(platformFoundationAtTarget('user-dawit', 5432)).toBeNull();
  });
});

describe('how a foundation is refused', () => {
  it('answers absence, not prohibition, and names no reason', () => {
    let thrown: unknown;
    try {
      assertNotPlatformFoundation(row({ slug: 'zitadel' }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NotFoundException);
    const message = (thrown as NotFoundException).message;
    expect(message).toBe(CONSOLE_TARGET_ABSENT);
    expect(message.toLowerCase()).not.toMatch(
      /forbidden|denied|platform|foundation|zitadel|postgres|identity/,
    );
  });

  it('lets an ordinary application through untouched', () => {
    expect(() =>
      assertNotPlatformFoundation(row({ slug: 'umami-3311' })),
    ).not.toThrow();
  });

  it('lets a missing row through, so absence and fence read alike downstream', () => {
    expect(() => assertNotPlatformFoundation(null)).not.toThrow();
  });
});

/**
 * The carve-out, pinned against the thing it must not become.
 *
 * The reach list is the one place the product says how to get at a foundation
 * at all, and the failure it could turn into is not "the coordinates are
 * wrong" — it is "somebody widened the fence while adding to this". So these
 * ask the fence the same questions after the reach exists as before, and they
 * ask the reach to name only foundations that are still refused.
 */
describe('the road that is deliberately open', () => {
  it('reaches only things the fence still names as foundations', () => {
    const keys = PLATFORM_FOUNDATIONS.map((f) => f.key);
    for (const reach of FOUNDATION_REACH) {
      expect(keys).toContain(reach.key);
    }
  });

  it('leaves every target it names refused at the transport', () => {
    for (const reach of FOUNDATION_REACH) {
      expect(
        platformFoundationAtTarget(reach.namespace, reach.remotePort),
      ).not.toBeNull();
    }
  });

  it('still answers a foundation row as absent, reach or no reach', () => {
    for (const reach of FOUNDATION_REACH) {
      expect(() =>
        assertNotPlatformFoundation(
          row({ slug: 'postgres', k8sNamespace: reach.namespace }),
        ),
      ).toThrow(CONSOLE_TARGET_ABSENT);
    }
  });

  it('selects the pod by a label the workload controller itself enforces', () => {
    // `flui-app-id=<id>` is coined by Flui at discovery, so a bootstrap-created
    // pod cannot carry it — that mistake is why a console answers 500 here.
    for (const reach of FOUNDATION_REACH) {
      expect(reach.podLabelSelector).not.toContain('flui-app-id');
      expect(reach.podLabelSelector).toMatch(/^[a-z0-9./-]+=[a-z0-9.-]+$/);
    }
  });

  it('names no Secret and no key — the password keeps its address off the wire', () => {
    expect(JSON.stringify(FOUNDATION_REACH).toLowerCase()).not.toContain(
      'secret',
    );
    expect(JSON.stringify(FOUNDATION_REACH).toLowerCase()).not.toContain(
      'password',
    );
  });

  it('offers the identity provider its user role and not the role that owns the schema', () => {
    const identity = foundationReachOf('identity-provider');
    expect(identity?.user).toBe('zitadel_user');
  });

  it('answers nothing for a key that names no foundation', () => {
    expect(foundationReachOf('grafana')).toBeNull();
    expect(foundationReachOf('')).toBeNull();
    expect(foundationReachOf(undefined)).toBeNull();
  });
});
