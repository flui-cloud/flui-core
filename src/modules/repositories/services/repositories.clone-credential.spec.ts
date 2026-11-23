jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { InternalServerErrorException } from '@nestjs/common';
import { RepositoriesService } from './repositories.service';
import { GITHUB_TOKEN_INVALID } from '../../git/utils/github-credential-rejected';

const REPOSITORY = {
  id: 'repo-1',
  userId: 'u1',
  defaultBranch: 'main',
  repositoryFullName: 'acme/app',
  cloneUrl: 'https://github.com/acme/app.git',
  accessTokenEncrypted: 'enc',
};

function build(cloneError: string, appMode = false): RepositoriesService {
  const none = {} as never;
  return new RepositoriesService(
    { findById: async () => REPOSITORY } as never,
    none,
    { decrypt: () => 'token' } as never,
    none,
    none,
    none,
    {
      isAppMode: async () => appMode,
      getAccessToken: async () => 'installation-token',
    } as never,
    none,
    {
      cloneRepository: async () => ({
        localPath: 'clone-workspace/acme-app',
        success: false,
        error: cloneError,
      }),
      cleanup: async () => undefined,
    } as never,
    none,
    none,
    none,
    none,
  );
}

const REJECTED =
  "fatal: Authentication failed for 'https://github.com/acme/app.git/'";

describe('cloning a repository with a token GitHub no longer accepts', () => {
  it('answers the wizard analysis with the rejected repository token', async () => {
    await expect(
      build(REJECTED).analyzeRepository('u1', 'repo-1', {} as never),
    ).rejects.toMatchObject({
      response: { code: GITHUB_TOKEN_INVALID, credential: 'repository-token' },
    });
  });

  it('names the GitHub App when the installation token is the one in use', async () => {
    await expect(
      build(REJECTED, true).analyzeRepository('u1', 'repo-1', {} as never),
    ).rejects.toMatchObject({
      response: { code: GITHUB_TOKEN_INVALID, credential: 'github-app' },
    });
  });

  it('answers the variable extraction the same way', async () => {
    await expect(
      build(REJECTED).extractEnv('u1', 'repo-1', {
        branch: 'main',
        framework: 'nestjs',
      } as never),
    ).rejects.toMatchObject({
      response: { code: GITHUB_TOKEN_INVALID },
    });
  });

  it('keeps any other clone failure as it was', async () => {
    await expect(
      build(
        'fatal: unable to access: Could not resolve host',
      ).analyzeRepository('u1', 'repo-1', {} as never),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
