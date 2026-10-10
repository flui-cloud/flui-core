jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('../../repositories/services/ghcr-packages.service', () => ({
  GhcrPackagesService: class {},
}));
jest.mock('../../applications/services/application-deploy.service', () => ({
  ApplicationDeployService: class {},
}));
jest.mock('../../applications/services/application.service', () => ({
  ApplicationService: class {},
}));

import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ImageRegistryController } from './image-registry.controller';
import { ImageRegistryService } from '../services/image-registry.service';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import {
  APP_ACTION_KEY,
  AppAccessGuard,
} from '../../applications/guards/app-access.guard';

const app = {
  id: 'app-1',
  slug: 'web',
  userId: 'owner',
  imageRef: 'ghcr.io/acme/flui-web:abc',
  sourceConfig: { repositoryId: 'repo-1' },
};
const image = { id: 'img-1', appId: 'app-1', imageRef: 'ghcr.io/acme/x:1' };

const service = () => {
  const deploy = {
    triggerDeployWithImage: jest.fn(async () => ({
      id: 'op-1',
      status: 'pending',
    })),
  };
  const images = {
    findById: jest.fn(async () => image),
    findByAppId: jest.fn(async () => []),
    updateCurrentlyDeployed: jest.fn(),
    clearCurrentlyDeployed: jest.fn(),
  };
  const svc = new ImageRegistryService(
    images as never,
    { findById: jest.fn(async () => app) } as never,
    {
      findOwnedById: jest.fn(async () => ({ id: 'repo-1', owner: 'acme' })),
    } as never,
    {
      listVersions: jest.fn(async () => [{ versionId: 1, tags: ['v1'] }]),
    } as never,
    deploy as never,
    {} as never,
    {} as never,
  );
  jest.spyOn(svc, 'setActiveImage').mockResolvedValue(undefined as never);
  return { svc, deploy };
};

describe('deploying from the image registry asks IAM, not ownership', () => {
  it('lets a collaborator holding app:deploy deploy an image by id', async () => {
    const { svc, deploy } = service();

    await expect(svc.deployImageById('img-1', 'collaborator')).resolves.toEqual(
      { id: 'op-1', status: 'pending' },
    );
    expect(deploy.triggerDeployWithImage).toHaveBeenCalled();
  });

  it('lets a collaborator redeploy a GHCR tag', async () => {
    const { svc, deploy } = service();

    await svc.redeployGhcrTag('app-1', 'v1');
    expect(deploy.triggerDeployWithImage).toHaveBeenCalledWith(
      'app-1',
      'ghcr.io/acme/flui-web:v1',
      'owner',
    );
  });

  const controller = (assertCan: jest.Mock) => {
    const imageRegistry = {
      getImage: jest.fn(async () => image),
      deployImageById: jest.fn(async () => ({ id: 'op-1', status: 'pending' })),
    };
    return {
      imageRegistry,
      ctl: new ImageRegistryController(
        imageRegistry as never,
        { assertCan } as never,
        { findById: jest.fn(async () => app) } as never,
      ),
    };
  };

  it('asks app:deploy on the image’s application before deploying it', async () => {
    const assertCan = jest.fn(async () => undefined);
    const { ctl, imageRegistry } = controller(assertCan);

    await ctl.deployImage('img-1', { user: { userId: 'u1' } } as never);

    expect(assertCan).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      IAM_PERMISSION.APP_DEPLOY,
      app,
    );
    expect(imageRegistry.deployImageById).toHaveBeenCalled();
  });

  it('refuses the deploy when IAM says no', async () => {
    const assertCan = jest.fn(async () => {
      throw new ForbiddenException('no');
    });
    const { ctl, imageRegistry } = controller(assertCan);

    await expect(
      ctl.deployImage('img-1', { user: { userId: 'u1' } } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(imageRegistry.deployImageById).not.toHaveBeenCalled();
  });

  it('gates the GHCR redeploy with app:deploy on the named application', () => {
    const handler = ImageRegistryController.prototype.redeployGhcrTag;
    const guards = Reflect.getMetadata('__guards__', handler) ?? [];
    expect(guards).toContain(AppAccessGuard);
    expect(new Reflector().get(APP_ACTION_KEY, handler)).toBe(
      IAM_PERMISSION.APP_DEPLOY,
    );
  });
});
