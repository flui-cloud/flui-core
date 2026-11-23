import { HttpStatus } from '@nestjs/common';

jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));

import { GitHubProviderService } from '../services/github-provider.service';
import {
  GITHUB_TOKEN_INVALID,
  githubCredentialRejected,
  isGitAuthFailure,
  isGithubCredentialRejection,
} from './github-credential-rejected';

describe('a GitHub credential GitHub no longer accepts', () => {
  it('is a failed dependency, never a 401 that signs the person out', () => {
    const error = githubCredentialRejected('repository-token');
    expect(error.getStatus()).toBe(HttpStatus.FAILED_DEPENDENCY);
    expect(error.getResponse()).toMatchObject({
      code: GITHUB_TOKEN_INVALID,
      credential: 'repository-token',
    });
  });

  it('is recognised from the status Octokit or an HTTP client reports', () => {
    expect(isGithubCredentialRejection({ status: 401 })).toBe(true);
    expect(isGithubCredentialRejection({ response: { status: 401 } })).toBe(
      true,
    );
    expect(isGithubCredentialRejection({ status: 403 })).toBe(false);
    expect(isGithubCredentialRejection(undefined)).toBe(false);
  });
});

describe('listing branches with a rejected token', () => {
  const provider = new GitHubProviderService();
  const withOctokit = (listBranches: jest.Mock) =>
    jest
      .spyOn(provider as never, 'getOctokit')
      .mockReturnValue({ repos: { listBranches } } as never);

  afterEach(() => jest.restoreAllMocks());

  it('names the credential that was refused', async () => {
    withOctokit(
      jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('Bad credentials'), { status: 401 }),
        ),
    );
    await expect(
      provider.listBranches(
        { accessToken: 't', credential: 'repository-token' },
        'o',
        'r',
      ),
    ).rejects.toMatchObject({
      response: { code: GITHUB_TOKEN_INVALID, credential: 'repository-token' },
    });
  });

  it('keeps any other failure as it was', async () => {
    withOctokit(
      jest
        .fn()
        .mockRejectedValue(Object.assign(new Error('boom'), { status: 502 })),
    );
    await expect(
      provider.listBranches({ accessToken: 't' }, 'o', 'r'),
    ).rejects.toThrow('Failed to list branches: boom');
  });
});

describe('a clone refused for its token', () => {
  it('is recognised from what git prints', () => {
    expect(
      isGitAuthFailure(
        "fatal: Authentication failed for 'https://github.com/o/r.git/'",
      ),
    ).toBe(true);
    expect(
      isGitAuthFailure(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      ),
    ).toBe(true);
    expect(
      isGitAuthFailure(
        'fatal: Remote branch nope not found in upstream origin',
      ),
    ).toBe(false);
    expect(isGitAuthFailure(undefined)).toBe(false);
  });
});
