jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));

import {
  GhcrSecretRefreshService,
  ghcrPullSecretName,
} from './ghcr-secret-refresh.service';
import { ApplicationEntity } from '../entities/application.entity';

describe('pull secrets in a shared project namespace', () => {
  const applied: string[] = [];
  const service = new GhcrSecretRefreshService(
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    {
      applyManifest: async (_kc: string, manifest: string) => {
        applied.push(manifest);
      },
    } as never,
    undefined as never,
    undefined as never,
  );
  (
    service as unknown as {
      resolvePullCredentials: () => Promise<unknown>;
    }
  ).resolvePullCredentials = async () => ({
    username: 'someone',
    token: 't',
    source: 'pat',
  });

  const app = (slug: string, userId: string) =>
    ({
      id: slug,
      slug,
      userId,
      imageRef: `ghcr.io/acme/${slug}:1`,
      k8sNamespace: 'p-web-team',
    }) as unknown as ApplicationEntity;

  it('gives each application its own secret, so one owner never overwrites another', async () => {
    const a = await service.ensureSecretForApp('kc', app('api', 'u1'));
    const b = await service.ensureSecretForApp('kc', app('web', 'u2'));

    expect(a).toBe(ghcrPullSecretName('api'));
    expect(b).toBe(ghcrPullSecretName('web'));
    expect(a).not.toBe(b);
    expect(applied[0]).toContain(`name: ${a}`);
    expect(applied[1]).toContain(`name: ${b}`);
  });
});
