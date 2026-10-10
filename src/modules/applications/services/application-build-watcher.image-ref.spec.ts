jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { ApplicationBuildWatcherService } from './application-build-watcher.service';

const watcher = new (ApplicationBuildWatcherService as unknown as new (
  ...args: unknown[]
) => ApplicationBuildWatcherService)();
const compose = (app: object) =>
  (
    watcher as unknown as {
      composeImageRef: (
        a: object,
        r: { owner: string; repositoryName: string },
        sha: string,
      ) => string;
    }
  ).composeImageRef(app, { owner: 'Acme', repositoryName: 'Shop' }, 'abc1234');

describe('the image a finished build is rolled out from', () => {
  it('is the application’s own repository on the registry its workflow pushes to', () => {
    expect(
      compose({
        id: '11111111-1111-4111-8111-111111111111',
        imageRegistryHost: 'api.example.test',
        sourceConfig: { type: 'git_build', subPath: 'web' },
      }),
    ).toBe(
      'api.example.test/apps/11111111-1111-4111-8111-111111111111:abc1234',
    );
  });

  it('stays on GHCR, monorepo path included, for an application set up there', () => {
    expect(
      compose({
        id: 'x',
        imageRegistryHost: null,
        sourceConfig: { type: 'git_build', subPath: 'web' },
      }),
    ).toBe('ghcr.io/acme/shop/web:abc1234');
  });
});
