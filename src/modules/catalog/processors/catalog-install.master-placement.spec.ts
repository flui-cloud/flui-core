// Same reason as the sibling spec: the processor's import graph reaches
// ESM-only packages ts-jest cannot transform. Nothing is constructed here.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { CatalogInstallProcessor } from './catalog-install.processor';

/**
 * Found live: a sandbox guest installed a catalogue app and the resulting
 * application carried `allowMasterPlacement: true`, even though the guest's own
 * request had been stripped at the door. The value came from `FLUI_ALLOW_MASTER`
 * — an operator's switch for their own cluster — which the processor OR-ed back
 * in. On a single-node cluster that changes nothing; on the multi-node instance
 * the public demo will run on, it puts a stranger's workload on the node that
 * runs Flui itself.
 *
 * The distinction the fix has to keep: an *explicit* value still wins, because
 * the sandbox seed sets one on purpose (SANDBOX_ALLOW_MASTER_PLACEMENT) so its
 * own `dedicated` components can start where there is no worker node.
 */
describe('who may schedule on the control plane', () => {
  const CLUSTER = 'cluster-1';
  const GUEST = 'guest-abc123@try.flui.cloud';
  const PERSON = 'someone@example.com';

  /** Stands in for the repository: true when the namespace is a tenancy. */
  const withTenancies = (namespaces: string[]) => ({
    sandboxTenants: {
      exists: ({ where }: { where: { namespace: string } }) =>
        Promise.resolve(namespaces.includes(where.namespace)),
    },
  });

  const resolve = (
    self: unknown,
    install: {
      clusterId: string;
      userEmail?: string;
      allowMasterPlacement: boolean;
    },
  ): Promise<boolean> =>
    (
      CatalogInstallProcessor.prototype as unknown as {
        allowMasterPlacementFor: (i: unknown) => Promise<boolean>;
      }
    ).allowMasterPlacementFor.call(self, install);

  const original = process.env.FLUI_ALLOW_MASTER;
  afterEach(() => {
    if (original === undefined) delete process.env.FLUI_ALLOW_MASTER;
    else process.env.FLUI_ALLOW_MASTER = original;
  });

  it('refuses by default, with no flag and nothing asked for', async () => {
    delete process.env.FLUI_ALLOW_MASTER;
    const allowed = await resolve(withTenancies([]), {
      clusterId: CLUSTER,
      userEmail: PERSON,
      allowMasterPlacement: false,
    });
    expect(allowed).toBe(false);
  });

  it('honours the operator flag for an ordinary user', async () => {
    process.env.FLUI_ALLOW_MASTER = 'true';
    const allowed = await resolve(withTenancies([]), {
      clusterId: CLUSTER,
      userEmail: PERSON,
      allowMasterPlacement: false,
    });
    expect(allowed).toBe(true);
  });

  it('does not let that flag reach a sandbox guest', async () => {
    process.env.FLUI_ALLOW_MASTER = 'true';
    const allowed = await resolve(withTenancies(['user-guest-abc123']), {
      clusterId: CLUSTER,
      userEmail: GUEST,
      allowMasterPlacement: false,
    });
    expect(allowed).toBe(false);
  });

  it('still honours an explicit value, which is how the seed starts', async () => {
    // The tenancy's own seed asks for it deliberately: its `dedicated`
    // components have nowhere else to run on a single-node cluster. Refusing
    // here would leave every guest looking at a tenancy that never came up.
    delete process.env.FLUI_ALLOW_MASTER;
    const allowed = await resolve(withTenancies(['user-guest-abc123']), {
      clusterId: CLUSTER,
      userEmail: GUEST,
      allowMasterPlacement: true,
    });
    expect(allowed).toBe(true);
  });

  it('does not consult the tenancy table when the flag is off', async () => {
    delete process.env.FLUI_ALLOW_MASTER;
    const exists = jest.fn();
    await resolve(
      { sandboxTenants: { exists } },
      {
        clusterId: CLUSTER,
        userEmail: GUEST,
        allowMasterPlacement: false,
      },
    );
    expect(exists).not.toHaveBeenCalled();
  });
});
