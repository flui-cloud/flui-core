jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { BadRequestException } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { ApplicationStatus } from '../applications/enums/application-status.enum';

const TOKEN = 'b6f0a2de-1f0a-4a7a-9a5f-0f2c5a9d1e77';
const HOST = 'api.example.test';
const MINE = '11111111-1111-4111-8111-111111111111';
const THEIRS = '22222222-2222-4222-8222-222222222222';

function build(imageRegistryHost: string | null) {
  const deployed: string[] = [];
  const service = new WebhooksService(
    {
      findOne: async () => ({
        id: MINE,
        webhookToken: TOKEN,
        status: ApplicationStatus.AWAITING_BUILD,
        imageRegistryHost,
      }),
      update: async () => undefined,
    } as never,
    {
      triggerDeployWithImage: async (_id: string, ref: string) => {
        deployed.push(ref);
      },
    } as never,
    { reapplyManifestAtCommit: async () => undefined } as never,
    new Proxy({}, { get: () => jest.fn() }) as never,
    { recordImage: async () => undefined } as never,
    { host: () => HOST } as never,
  );
  const post = (imageRef: string) =>
    service.handleGitHubActionsWebhook(TOKEN, {
      appId: MINE,
      imageRef,
      commitSha: 'abc',
      branch: 'main',
      status: 'success',
    } as never);
  return { post, deployed };
}

describe('the image a build reports, on the instance’s own registry', () => {
  it('rolls out the application’s own image', async () => {
    const { post, deployed } = build(HOST);
    await post(`${HOST}/apps/${MINE}:abc1234`);
    expect(deployed).toEqual([`${HOST}/apps/${MINE}:abc1234`]);
  });

  it('refuses another application’s image, though the token is valid', async () => {
    const { post, deployed } = build(HOST);
    await expect(post(`${HOST}/apps/${THEIRS}:abc1234`)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(deployed).toEqual([]);
  });

  it('refuses an image from elsewhere for an application set up for the registry', async () => {
    const { post } = build(HOST);
    await expect(post('docker.io/library/nginx:1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses another application’s registry image even for a GHCR application', async () => {
    const { post, deployed } = build(null);
    await expect(post(`${HOST}/apps/${THEIRS}:abc1234`)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await post('ghcr.io/someone/their-app:abc1234');
    expect(deployed).toEqual(['ghcr.io/someone/their-app:abc1234']);
  });
});
