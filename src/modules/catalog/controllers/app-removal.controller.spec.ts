// The controller's import graph reaches ESM-only packages ts-jest cannot
// transform; this suite constructs the controller with stubs and calls one method.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { AppRemovalController } from './app-removal.controller';
import { CatalogInstallStatus } from '../enums/catalog-install-status.enum';

/**
 * The orchestration that had to stop being a client's job.
 *
 * Every component of a multi-component install maps to the SAME install, and a
 * model asked to "remove Immich" tends to call remove once per component it was
 * shown. Composed out of the existing routes the decision took four calls with
 * the model's own retries landing in the gaps; here read-and-decide is one
 * request, so the second component finds the install already UNINSTALLING and
 * is told so instead of queueing a second teardown.
 */
describe('DELETE /applications/:id/install', () => {
  const app = { id: 'a1', name: 'immich-web', clusterId: 'c1' };
  const req = { user: { userId: 'u1' } } as never;

  const build = (over: {
    install?: Record<string, unknown> | null;
    uninstall?: jest.Mock;
    deleteApplication?: jest.Mock;
  }) => {
    const uninstall =
      over.uninstall ??
      jest.fn().mockResolvedValue({
        operation: { id: 'op2', status: 'PENDING' },
      });
    const deleteApplication =
      over.deleteApplication ??
      jest.fn().mockResolvedValue({ id: 'op3', status: 'PENDING' });
    const controller = new AppRemovalController(
      { findById: jest.fn().mockResolvedValue(app) } as never,
      {
        findInstallByApplicationId: jest
          .fn()
          .mockResolvedValue(over.install ?? null),
        uninstall,
      } as never,
      { deleteApplication } as never,
      { preview: jest.fn() } as never,
    );
    return { controller, uninstall, deleteApplication };
  };

  it('removes the whole install when the application belongs to one', async () => {
    const { controller, uninstall, deleteApplication } = build({
      install: {
        id: 'inst1',
        status: CatalogInstallStatus.RUNNING,
        displayName: 'Immich',
      },
    });

    const out = await controller.remove('a1', req);

    expect(out).toMatchObject({
      removed: 'catalog-install',
      operationId: 'op2',
      done: false,
      label: 'Uninstall Immich',
    });
    expect(uninstall).toHaveBeenCalledWith('inst1', 'u1');
    expect(deleteApplication).not.toHaveBeenCalled();
  });

  it('removes the application alone when it belongs to no install', async () => {
    const { controller, uninstall, deleteApplication } = build({
      install: null,
    });

    const out = await controller.remove('a1', req);

    expect(out).toMatchObject({
      removed: 'application',
      operationId: 'op3',
      label: 'Delete immich-web',
    });
    expect(deleteApplication).toHaveBeenCalledWith('a1', 'u1');
    expect(uninstall).not.toHaveBeenCalled();
  });

  it.each([
    [CatalogInstallStatus.UNINSTALLING, false],
    [CatalogInstallStatus.UNINSTALLED, true],
  ])('reports %s as a state and starts nothing new', async (status, done) => {
    const { controller, uninstall, deleteApplication } = build({
      install: {
        id: 'inst1',
        status,
        displayName: 'Immich',
        operationId: 'op-prev',
      },
    });

    const out = await controller.remove('a1', req);

    expect(out).toMatchObject({
      removed: 'catalog-install',
      operationId: 'op-prev',
      done,
      alreadyUnderway: true,
    });
    expect(uninstall).not.toHaveBeenCalled();
    expect(deleteApplication).not.toHaveBeenCalled();
  });

  // The existing `DELETE /applications/:id` does not pass one, so a delete it
  // starts belongs to nobody and its owner-checked operation read refuses
  // everyone. This route was written after that rule and carries the caller.
  it('records the caller as the owner of the operation it starts', async () => {
    const { controller, deleteApplication } = build({ install: null });
    await controller.remove('a1', { user: { userId: 'someone' } } as never);
    expect(deleteApplication).toHaveBeenCalledWith('a1', 'someone');
  });
});
