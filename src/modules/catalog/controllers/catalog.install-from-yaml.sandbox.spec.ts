jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { CatalogController } from './catalog.controller';

/**
 * Placement is an infrastructure decision; a sandbox guest does not get to put
 * a workload on the control plane by installing from a manifest instead of
 * from the catalog.
 */
describe('installing from a manifest of your own', () => {
  const build = (isSandbox: boolean) => {
    const installer = {
      install: jest.fn(async () => ({ install: { id: 'i1' } })),
    };
    const controller = new CatalogController(
      {
        upsertFromYaml: jest.fn(async () => ({ slug: 'mine', name: 'Mine' })),
      } as never,
      installer as never,
      {} as never,
      {} as never,
      {} as never,
      { assertCanCreate: jest.fn(async () => ({ isSandbox })) } as never,
      {} as never,
    );
    jest
      .spyOn(controller as never, 'toResponse' as never)
      .mockImplementation((() => ({})) as never);
    return { controller, installer };
  };
  const req = { user: { userId: 'u1', email: 'u1@example.com' } } as never;
  const body = {
    yaml: 'kind: CatalogApp',
    clusterId: 'c1',
    allowMasterPlacement: true,
  } as never;

  it('drops the master placement a sandbox guest asks for', async () => {
    const { controller, installer } = build(true);
    await controller.installFromYaml(body, req);
    const [, dto] = installer.install.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(dto).not.toHaveProperty('allowMasterPlacement');
  });

  it('keeps it for everyone else', async () => {
    const { controller, installer } = build(false);
    await controller.installFromYaml(body, req);
    const [, dto] = installer.install.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(dto.allowMasterPlacement).toBe(true);
  });
});
