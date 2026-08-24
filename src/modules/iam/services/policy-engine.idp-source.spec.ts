import { PolicyEngineService } from './policy-engine.service';
import { IamRoleBindingEntity } from '../entities/iam-role-binding.entity';
import { IamPrincipal } from '../interfaces/iam.types';
import { IdentityRole } from '../../auth/entities/user.entity';
import { IAM_PERMISSION } from '../constants/iam-permissions';
import { IAM_ROLE } from '../constants/iam-roles';

type Binding = Pick<
  IamRoleBindingEntity,
  | 'principalType'
  | 'principalRef'
  | 'role'
  | 'scopeType'
  | 'scopeRef'
  | 'selector'
>;

function makeEngine(rows: Binding[]): PolicyEngineService {
  const bindingsRepo = {
    createQueryBuilder: () => {
      const qb: Record<string, unknown> = {};
      qb.where = () => qb;
      qb.orWhere = () => qb;
      qb.getMany = async () => rows;
      return qb;
    },
  };
  return new PolicyEngineService(
    bindingsRepo as never,
    {
      find: async () => [],
    } as never,
  );
}

const principal = (overrides: Partial<IamPrincipal> = {}): IamPrincipal => ({
  userId: 'u-1',
  email: 'someone@acme.com',
  role: IdentityRole.USER,
  isAdmin: false,
  ...overrides,
});

/** What Zitadel puts in the token: roleKey → { orgId: primaryDomain }. */
const claim = (...keys: string[]) =>
  Object.fromEntries(keys.map((k) => [k, { org: 'acme.localhost' }]));

/** The guest's binding, verbatim from `sandbox-tenant.service.ts`. */
const guestBinding = (owner: string): Binding =>
  ({
    principalType: 'user',
    principalRef: 'guest@sandbox.invalid',
    role: IAM_ROLE.SANDBOX,
    scopeType: 'selector',
    scopeRef: null,
    selector: { owner },
  }) as Binding;

describe('the provider as a second source, beside the table', () => {
  describe('a rung granted in the provider is access', () => {
    it('carries the rung’s permissions with no row in the table at all', async () => {
      const engine = makeEngine([]);
      const me = principal({ roles: claim('maintainer') });
      expect(await engine.check(me, IAM_PERMISSION.CLUSTER_MANAGE)).toBe(true);
      expect(await engine.check(me, IAM_PERMISSION.IAM_ASSIGN_ROLE)).toBe(true);
      // Stops exactly where the rung stops.
      expect(await engine.check(me, IAM_PERMISSION.CLUSTER_DESTROY)).toBe(
        false,
      );
      expect(await engine.check(me, IAM_PERMISSION.IAM_MANAGE_USERS)).toBe(
        false,
      );
    });

    it('is a union with the table, never an override in either direction', async () => {
      const engine = makeEngine([
        {
          principalType: 'user',
          principalRef: 'someone@acme.com',
          role: IAM_ROLE.OPERATOR,
          scopeType: 'cluster',
          scopeRef: 'c1',
          selector: null,
        } as Binding,
      ]);
      const me = principal({ roles: claim('viewer') });
      const access = await engine.resolveAccess(me);
      // The provider's viewer is global; the table's operator reaches c1 only.
      expect(
        engine.can(access, IAM_PERMISSION.APP_READ, { clusterId: 'c2' }),
      ).toBe(true);
      expect(
        engine.can(access, IAM_PERMISSION.APP_DELETE, { clusterId: 'c1' }),
      ).toBe(true);
      expect(
        engine.can(access, IAM_PERMISSION.APP_DELETE, { clusterId: 'c2' }),
      ).toBe(false);
    });

    /**
     * The floor deny-by-default removed does not come back: `pickHighestRole`
     * answers `user` for a claim that names nothing, and `user` is not a rung.
     */
    it('gives nothing to a claim that names no rung', async () => {
      const engine = makeEngine([]);
      const me = principal({ roles: claim('user', 'admin', 'readonly') });
      const access = await engine.resolveAccess(me);
      expect([...access.globalPermissions]).toEqual([]);
      expect(access.scopedGrants).toEqual([]);
    });
  });

  describe('what the provider cannot say, and what happens if it tries', () => {
    it('cannot make a guest: the sandbox role never arrives from a claim', async () => {
      const engine = makeEngine([]);
      const access = await engine.resolveAccess(
        principal({ roles: claim(IAM_ROLE.SANDBOX, IAM_ROLE.SHOWCASE_VIEWER) }),
      );
      expect(access.isSandbox).toBe(false);
      expect([...access.globalPermissions]).toEqual([]);
    });

    /**
     * The overlap attempt, made concretely: the same identity holds the guest's
     * selector-bound binding in Flui and an `operator` rung in the provider.
     * There is no conflict to resolve — the two say different kinds of thing —
     * so the answer is the union, and the guest's *selector* still decides which
     * applications the sandbox half reaches.
     */
    it('a delegation in the table and a rung in the provider do not compete', async () => {
      const engine = makeEngine([guestBinding('u-1')]);
      const access = await engine.resolveAccess(
        principal({ roles: claim('operator') }),
      );
      expect(access.isSandbox).toBe(true);
      // The selector half still discriminates by owner…
      expect(
        engine.can(access, IAM_PERMISSION.APP_DELETE, {
          owner: 'someone-else',
        }),
      ).toBe(true); // …granted here by the *global* operator rung, not the selector
      const selectorOnly = engine.accessFrom([guestBinding('u-1')]);
      expect(
        engine.can(selectorOnly, IAM_PERMISSION.APP_DELETE, {
          owner: 'someone-else',
        }),
      ).toBe(false);
      expect(
        engine.can(selectorOnly, IAM_PERMISSION.APP_DELETE, { owner: 'u-1' }),
      ).toBe(true);
    });

    it('never produces a scoped grant, whatever the claim contains', async () => {
      const engine = makeEngine([]);
      const bindings = await engine.bindingsFor(
        principal({
          roles: claim('owner', 'maintainer', 'operator', 'viewer'),
        }),
      );
      for (const b of bindings) {
        expect(b.scopeType).toBe('global');
        expect(b.selector).toBeNull();
      }
    });
  });

  describe('AUTH_MODE=local', () => {
    /**
     * Both local strategies populate `roles: {}` — there is no provider to fill
     * it. Asserted against the resolved access rather than against the reader so
     * that it covers the wiring and not only the function.
     */
    it('resolves exactly as it did before this source existed', async () => {
      const rows: Binding[] = [
        {
          principalType: 'user',
          principalRef: 'someone@acme.com',
          role: IAM_ROLE.OPERATOR,
          scopeType: 'global',
          scopeRef: null,
          selector: null,
        } as Binding,
      ];
      const withEmptyClaim = await makeEngine(rows).resolveAccess(
        principal({ roles: {} }),
      );
      const withNoClaimField =
        await makeEngine(rows).resolveAccess(principal());
      const sorted = (perms: ReadonlySet<string>) =>
        [...perms].sort((a, b) => a.localeCompare(b));
      expect(sorted(withEmptyClaim.globalPermissions)).toEqual(
        sorted(withNoClaimField.globalPermissions),
      );
      expect(withEmptyClaim.scopedGrants).toEqual(
        withNoClaimField.scopedGrants,
      );
    });

    it('an unbound principal still sees nothing', async () => {
      const access = await makeEngine([]).resolveAccess(
        principal({ roles: {} }),
      );
      expect([...access.globalPermissions]).toEqual([]);
      expect(access.scopedGrants).toEqual([]);
      expect(access.isSandbox).toBe(false);
    });
  });
});
