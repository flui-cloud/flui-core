jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { BadRequestException } from '@nestjs/common';
import { ApplicationSourceDeployService } from './application-source-deploy.service';

type Internals = {
  registry?: { host: () => string | null };
  ghcrPackagesService: { getLatestTag: jest.Mock };
  githubAppUserAuthService: { getGhcrPatStatus: jest.Mock };
  resolveSkipBuildImageRef: (o: object) => Promise<string>;
  buildsToInstanceRegistry: () => boolean;
};

function service(host: string | null): Internals {
  const svc = Object.create(
    ApplicationSourceDeployService.prototype,
  ) as Internals;
  svc.registry = { host: () => host };
  svc.ghcrPackagesService = { getLatestTag: jest.fn(async () => 'abc1234') };
  return svc;
}

describe('deploying from a manifest when the instance runs its own registry', () => {
  it('needs no GHCR token', () => {
    expect(service('api.example.test').buildsToInstanceRegistry()).toBe(true);
    expect(service(null).buildsToInstanceRegistry()).toBe(false);
  });

  it('does not go looking on GHCR for an image to skip the build with', async () => {
    const svc = service('api.example.test');
    await expect(
      svc.resolveSkipBuildImageRef({
        userId: 'u1',
        dto: { repoFullName: 'acme/shop' },
        app: null,
        owner: 'acme',
        repoName: 'shop',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.ghcrPackagesService.getLatestTag).not.toHaveBeenCalled();
  });

  it('still reuses the image an existing application runs', async () => {
    const svc = service('api.example.test');
    await expect(
      svc.resolveSkipBuildImageRef({
        userId: 'u1',
        dto: {},
        app: { imageRef: 'api.example.test/apps/a1:abc1234' },
        owner: 'acme',
        repoName: 'shop',
      }),
    ).resolves.toBe('api.example.test/apps/a1:abc1234');
  });
});
