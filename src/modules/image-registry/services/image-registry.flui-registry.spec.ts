jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ImageRegistryService } from './image-registry.service';

const HOST = 'api.example.test';
const APP = '11111111-1111-4111-8111-111111111111';
const NAME = `${HOST}/apps/${APP}`;
const CURRENT = `sha256:${'a'.repeat(64)}`;
const OLD = `sha256:${'b'.repeat(64)}`;

function harness() {
  const app = {
    id: APP,
    userId: 'owner',
    imageRegistryHost: HOST,
    imageRef: `${NAME}:new1234`,
  };
  const removed: string[] = [];
  const deployed: string[] = [];
  const ghcr = { listVersions: jest.fn(), deleteVersion: jest.fn() };
  const svc = new ImageRegistryService(
    { findByAppId: async () => [] } as never,
    { findById: async () => app } as never,
    { findOwnedById: jest.fn() } as never,
    ghcr as never,
    {
      triggerDeployWithImage: async (_id: string, ref: string) => {
        deployed.push(ref);
        return { id: 'op' };
      },
    } as never,
    { findOne: async () => null } as never,
    {
      listVersions: async () => [
        { versionId: 1, digest: CURRENT, tags: ['new1234', 'latest'] },
        { versionId: 2, digest: OLD, tags: ['old1234'] },
      ],
      deleteDigest: async (_id: string, digest: string) => {
        removed.push(digest);
      },
    } as never,
  );
  jest.spyOn(svc, 'setActiveImage').mockResolvedValue(undefined as never);
  return { svc, removed, deployed, ghcr };
}

describe('image versions of an application on the instance registry', () => {
  it('lists them from the registry, never from GitHub', async () => {
    const { svc, ghcr } = harness();
    const tags = await svc.listGhcrTagsForApp(APP, 'owner');
    expect(tags.map((t) => t.imageRef)).toEqual([
      `${NAME}:new1234`,
      `${NAME}:old1234`,
    ]);
    expect(ghcr.listVersions).not.toHaveBeenCalled();
  });

  it('deletes an old version, and refuses the one running', async () => {
    const { svc, removed } = harness();
    await svc.deleteGhcrTagForApp(APP, 2, 'owner');
    expect(removed).toEqual([OLD]);
    await expect(
      svc.deleteGhcrTagForApp(APP, 1, 'owner'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('redeploys a tag from the application’s own repository', async () => {
    const { svc, deployed } = harness();
    await svc.redeployGhcrTag(APP, 'old1234');
    expect(deployed).toEqual([`${NAME}:old1234`]);
  });

  it('keeps the versions to the application’s owner', async () => {
    const { svc } = harness();
    await expect(
      svc.listGhcrTagsForApp(APP, 'someone-else'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
