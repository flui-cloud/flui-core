// These controllers' import graphs reach ESM-only packages ts-jest cannot
// transform; the suite constructs each one with stubs and calls one method.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CatalogController } from '../catalog/controllers/catalog.controller';
import { AppEndpointController } from '../dns/controllers/app-endpoint.controller';
import { ImageRegistryController } from '../image-registry/controllers/image-registry.controller';
import { IAM_PERMISSION } from './constants/iam-permissions';

/**
 * The four routes of the second annotation pass where the question was not
 * "which permission" but "whose row is this".
 *
 * A permission decorator answers what a *credential* may exercise; it cannot
 * answer whether this particular install, endpoint or image belongs to the
 * caller, because a resource-less check is satisfied by any scoped grant that
 * carries the permission at all. All four took an id straight off the URL and
 * wrote, so an operator scoped to their own applications reached another
 * tenant's row by guessing a uuid — the shape of decision 4, and the reason
 * these four needed a lookup on top of the decorator rather than instead of it.
 *
 * Every case here is the same three questions: it refuses somebody else's row,
 * it lets the owner through, and the permission it asks for on that row is the
 * one written on the route.
 */
describe('the four routes where ownership is the question', () => {
  const owner = { userId: 'u1', isAdmin: false } as never;
  const stranger = new ForbiddenException('not yours');

  describe('DELETE /catalog/installs/:id', () => {
    const build = (over: {
      apps?: unknown[];
      install?: Record<string, unknown> | null;
      assertCan?: jest.Mock;
    }) => {
      const assertCan =
        over.assertCan ?? jest.fn().mockResolvedValue(undefined);
      const uninstall = jest.fn().mockResolvedValue({
        install: { id: 'i1', applicationIds: [], createdAt: new Date() },
      });
      const controller = new CatalogController(
        {} as never,
        { uninstall } as never,
        {} as never,
        {
          findById: jest
            .fn()
            .mockResolvedValue(
              over.install === undefined ? { id: 'i1' } : over.install,
            ),
        } as never,
        {} as never,
        { assertCan } as never,
        {
          findByCatalogInstall: jest.fn().mockResolvedValue(over.apps ?? []),
        } as never,
      );
      return { controller, assertCan, uninstall };
    };

    it('asks for app:delete on every application the install owns', async () => {
      const apps = [{ id: 'a1' }, { id: 'a2' }];
      const { controller, assertCan } = build({ apps });
      await controller
        .uninstall('i1', { user: owner } as never)
        .catch(() => undefined);
      expect(assertCan.mock.calls.map((c) => [c[1], c[2]])).toEqual([
        [IAM_PERMISSION.APP_DELETE, apps[0]],
        [IAM_PERMISSION.APP_DELETE, apps[1]],
      ]);
    });

    it('never reaches the uninstall when one component is somebody else’s', async () => {
      const { controller, uninstall } = build({
        apps: [{ id: 'a1' }, { id: 'a2' }],
        assertCan: jest
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(stranger),
      });
      await expect(
        controller.uninstall('i1', { user: owner } as never),
      ).rejects.toThrow(ForbiddenException);
      expect(uninstall).not.toHaveBeenCalled();
    });

    /**
     * An install that failed before creating anything names no application, so
     * there is no resource to ask about and the fallback is who asked for it.
     */
    it('falls back to who asked for it when the install made no application', async () => {
      const { controller, uninstall } = build({
        apps: [],
        install: { id: 'i1', userId: 'someone-else' },
      });
      await expect(
        controller.uninstall('i1', { user: owner } as never),
      ).rejects.toThrow(NotFoundException);
      expect(uninstall).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /endpoints/:id', () => {
    const build = (over: { app?: unknown; assertCan?: jest.Mock }) => {
      const assertCan =
        over.assertCan ?? jest.fn().mockResolvedValue(undefined);
      const deleteEndpointResources = jest.fn().mockResolvedValue(undefined);
      const deleteEndpoint = jest.fn().mockResolvedValue(undefined);
      const controller = new AppEndpointController(
        {
          getEndpoint: jest.fn().mockResolvedValue({ applicationId: 'a1' }),
          deleteEndpoint,
        } as never,
        { deleteEndpointResources } as never,
        {} as never,
        { assertCan } as never,
        {
          findById: jest
            .fn()
            .mockResolvedValue(
              over.app === undefined ? { id: 'a1' } : over.app,
            ),
        } as never,
      );
      return { controller, assertCan, deleteEndpoint, deleteEndpointResources };
    };

    it('asks for app:write on the application the endpoint belongs to', async () => {
      const { controller, assertCan, deleteEndpoint } = build({});
      await controller.deleteEndpoint('e1', { user: owner } as never);
      expect(assertCan).toHaveBeenCalledWith(owner, IAM_PERMISSION.APP_WRITE, {
        id: 'a1',
      });
      expect(deleteEndpoint).toHaveBeenCalledWith('e1');
    });

    it('removes no DNS record for somebody else’s application', async () => {
      const { controller, deleteEndpointResources, deleteEndpoint } = build({
        assertCan: jest.fn().mockRejectedValue(stranger),
      });
      await expect(
        controller.deleteEndpoint('e1', { user: owner } as never),
      ).rejects.toThrow(ForbiddenException);
      expect(deleteEndpointResources).not.toHaveBeenCalled();
      expect(deleteEndpoint).not.toHaveBeenCalled();
    });

    /** An endpoint whose application is gone is nobody's to keep. */
    it('still removes an endpoint whose application no longer exists', async () => {
      const { controller, deleteEndpoint } = build({ app: null });
      await controller.deleteEndpoint('e1', { user: owner } as never);
      expect(deleteEndpoint).toHaveBeenCalledWith('e1');
    });
  });

  describe('DELETE /image-registry/:imageId (and its tag sibling)', () => {
    const build = (over: { app?: unknown; assertCan?: jest.Mock }) => {
      const assertCan =
        over.assertCan ?? jest.fn().mockResolvedValue(undefined);
      const deleteImage = jest.fn().mockResolvedValue(undefined);
      const removeFluiTag = jest.fn().mockResolvedValue({ id: 'img1' });
      const controller = new ImageRegistryController(
        {
          getImage: jest.fn().mockResolvedValue({ id: 'img1', appId: 'a1' }),
          deleteImage,
          removeFluiTag,
        } as never,
        { assertCan } as never,
        {
          findById: jest
            .fn()
            .mockResolvedValue(
              over.app === undefined ? { id: 'a1' } : over.app,
            ),
        } as never,
      );
      return { controller, assertCan, deleteImage, removeFluiTag };
    };

    it('asks for app:write on the application the image was built for', async () => {
      const { controller, assertCan, deleteImage } = build({});
      await controller.deleteImage('img1', { user: owner } as never);
      expect(assertCan).toHaveBeenCalledWith(owner, IAM_PERMISSION.APP_WRITE, {
        id: 'a1',
      });
      expect(deleteImage).toHaveBeenCalledWith('img1');
    });

    it('deletes no image record belonging to another application', async () => {
      const { controller, deleteImage } = build({
        assertCan: jest.fn().mockRejectedValue(stranger),
      });
      await expect(
        controller.deleteImage('img1', { user: owner } as never),
      ).rejects.toThrow(ForbiddenException);
      expect(deleteImage).not.toHaveBeenCalled();
    });

    it('applies the same rule to stripping a tag off it', async () => {
      const { controller, removeFluiTag } = build({
        assertCan: jest.fn().mockRejectedValue(stranger),
      });
      await expect(
        controller.removeFluiTag('img1', 'stable', { user: owner } as never),
      ).rejects.toThrow(ForbiddenException);
      expect(removeFluiTag).not.toHaveBeenCalled();
    });

    /** An image whose application row is gone answers 404, not 403. */
    it('answers 404 when the image names an application that is gone', async () => {
      const { controller, deleteImage } = build({ app: null });
      await expect(
        controller.deleteImage('img1', { user: owner } as never),
      ).rejects.toThrow(NotFoundException);
      expect(deleteImage).not.toHaveBeenCalled();
    });
  });

  /**
   * An unauthenticated request never reaches any of them.
   *
   * `JwtAuthGuard` refuses first in the running application, so this is the
   * belt: the assertions read the principal off the request and a missing one
   * must be a refusal, not an undefined that every comparison passes.
   */
  it('refuses all three when there is no principal at all', async () => {
    const catalog = new CatalogController(
      {} as never,
      { uninstall: jest.fn() } as never,
      {} as never,
      { findById: jest.fn() } as never,
      {} as never,
      { assertCan: jest.fn() } as never,
      { findByCatalogInstall: jest.fn() } as never,
    );
    const endpoints = new AppEndpointController(
      { getEndpoint: jest.fn(), deleteEndpoint: jest.fn() } as never,
      { deleteEndpointResources: jest.fn() } as never,
      {} as never,
      { assertCan: jest.fn() } as never,
      { findById: jest.fn() } as never,
    );
    const images = new ImageRegistryController(
      { getImage: jest.fn(), deleteImage: jest.fn() } as never,
      { assertCan: jest.fn() } as never,
      { findById: jest.fn() } as never,
    );
    await expect(catalog.uninstall('i1', {} as never)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(endpoints.deleteEndpoint('e1', {} as never)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(images.deleteImage('img1', {} as never)).rejects.toThrow(
      ForbiddenException,
    );
  });
});
