jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
const getAuthenticated = jest.fn();
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    users: { getAuthenticated },
  })),
}));

import { BadRequestException } from '@nestjs/common';
import { GitHubOAuthService } from './github-oauth.service';

const service = new GitHubOAuthService(
  {} as never,
  {} as never,
  {
    findByUserIdAndProvider: async () => ({
      accessTokenEncrypted: 'enc',
      isActive: true,
    }),
  } as never,
  { decrypt: () => 'token' } as never,
  {} as never,
);

describe('checking what a connected GitHub token may do', () => {
  beforeEach(() => getAuthenticated.mockReset());

  it('refuses a classic token that lacks a scope the operation needs', async () => {
    getAuthenticated.mockResolvedValue({
      data: {},
      headers: { 'x-oauth-scopes': 'repo' },
    });
    await expect(
      service.assertRequiredScopes('u1', ['repo', 'workflow']),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a classic token that holds them', async () => {
    getAuthenticated.mockResolvedValue({
      data: {},
      headers: { 'x-oauth-scopes': 'repo, workflow' },
    });
    await expect(
      service.assertRequiredScopes('u1', ['repo', 'workflow']),
    ).resolves.toBeUndefined();
  });

  it('lets a fine-grained token through, whose permissions GitHub checks per repository', async () => {
    getAuthenticated.mockResolvedValue({ data: {}, headers: {} });
    await expect(
      service.assertRequiredScopes('u1', ['repo', 'workflow']),
    ).resolves.toBeUndefined();
  });
});
