jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { ConflictException } from '@nestjs/common';
import { ApplicationDeployService } from './application-deploy.service';

function build(siblingsAlive: boolean, status = 'RUNNING') {
  const service = Object.create(ApplicationDeployService.prototype) as any;
  service.applicationService = {
    findById: jest.fn().mockResolvedValue({
      id: 'umami-app',
      name: 'umami-308040-umami',
      metadata: { catalogInstallId: 'inst-1' },
    }),
  };
  service.catalogInstalls = {
    findOne: jest.fn().mockResolvedValue({
      id: 'inst-1',
      displayName: 'umami-bktest',
      status,
      applicationIds: ['umami-app', 'umami-db'],
    }),
  };
  service.applicationRepository = {
    find: jest
      .fn()
      .mockResolvedValue(
        siblingsAlive ? [{ id: 'umami-db', name: 'umami-308040-db' }] : [],
      ),
  };
  return service as ApplicationDeployService;
}

describe('ApplicationDeployService.assertNotSplittingBundle', () => {
  it('refuses to delete one component while its database keeps running, naming both', async () => {
    const err = await build(true)
      .assertNotSplittingBundle('umami-app', false)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: 'PART_OF_BUNDLE',
      components: ['umami-308040-umami', 'umami-308040-db'],
    });
  });

  it('deletes only this component when that is asked for explicitly', async () => {
    await expect(
      build(true).assertNotSplittingBundle('umami-app', true),
    ).resolves.toBeUndefined();
  });

  it('lets the last component go, and the bundle removal itself', async () => {
    await expect(
      build(false).assertNotSplittingBundle('umami-app', false),
    ).resolves.toBeUndefined();
    await expect(
      build(true, 'UNINSTALLING').assertNotSplittingBundle('umami-app', false),
    ).resolves.toBeUndefined();
  });
});
