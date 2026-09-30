jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
const getAuthenticated = jest.fn();
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    users: { getAuthenticated },
  })),
}));

import { GitHubOAuthService } from './github-oauth.service';
import { GitHubAuthMethod } from '../enums/github-auth-method.enum';
import { credentialsVersion } from '../../credentials/credentials-version';

function serviceWith() {
  const create = jest.fn();
  const service = new GitHubOAuthService(
    {
      getConfig: jest.fn(async () => ({
        isConfigured: true,
        authMethod: GitHubAuthMethod.PAT,
      })),
    } as never,
    {} as never,
    { revokeAllByProvider: jest.fn(), create } as never,
    { encrypt: (v: string) => `enc:${v}` } as never,
    {} as never,
  );
  return { service, create };
}

describe('connecting GitHub with a personal access token', () => {
  it('records the scopes GitHub granted, not the ones Flui asks for', async () => {
    getAuthenticated.mockResolvedValue({
      data: { id: 7, login: 'octocat' },
      headers: { 'x-oauth-scopes': 'repo, read:packages' },
    });
    const { service, create } = serviceWith();

    await service.connectWithPat('u1', 'ghp_token');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'repo read:packages' }),
    );
  });

  it('falls back to the required list for a fine-grained token, which reports none', async () => {
    getAuthenticated.mockResolvedValue({
      data: { id: 7, login: 'octocat' },
      headers: {},
    });
    const { service, create } = serviceWith();

    await service.connectWithPat('u1', 'github_pat_token');

    expect(create.mock.calls[0][0].scope).toContain('repo');
  });

  it('refreshes the credentials status at once', async () => {
    getAuthenticated.mockResolvedValue({
      data: { id: 7, login: 'octocat' },
      headers: { 'x-oauth-scopes': 'repo' },
    });
    const { service } = serviceWith();
    const before = credentialsVersion();

    await service.connectWithPat('u1', 'ghp_token');

    expect(credentialsVersion()).toBeGreaterThan(before);
  });
});
