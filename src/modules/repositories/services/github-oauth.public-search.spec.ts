jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
const searchRepos = jest.fn();
const getRepo = jest.fn();
const listBranches = jest.fn();
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    search: { repos: searchRepos },
    repos: { get: getRepo, listBranches },
  })),
}));

import { NotFoundException } from '@nestjs/common';
import { GitHubOAuthService } from './github-oauth.service';

const service = new GitHubOAuthService(
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  { get: () => 'system-token' } as never,
);

const repo = (name: string, isPrivate: boolean) => ({
  name,
  full_name: `operator/${name}`,
  description: null,
  stargazers_count: 0,
  language: null,
  default_branch: 'main',
  clone_url: '',
  html_url: '',
  private: isPrivate,
});

describe('public repository lookups made with the system token', () => {
  beforeEach(() => jest.clearAllMocks());

  it('asks GitHub for public repositories only, and drops a private one that comes back anyway', async () => {
    searchRepos.mockResolvedValue({
      data: { items: [repo('site', false), repo('secrets', true)] },
    });

    const found = await service.searchPublicRepositories('operator', 10);

    expect(searchRepos.mock.calls[0][0].q).toBe('operator is:public');
    expect(found.map((r) => r.name)).toEqual(['site']);
  });

  it('refuses the branches of a private repository the system token can read', async () => {
    getRepo.mockResolvedValue({ data: { private: true } });

    await expect(
      service.getPublicRepoBranches('operator/secrets'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(listBranches).not.toHaveBeenCalled();
  });

  it('lists the branches of a public repository', async () => {
    getRepo.mockResolvedValue({ data: { private: false } });
    listBranches.mockResolvedValue({
      data: [{ name: 'main', commit: { sha: 'abc' } }],
    });

    await expect(
      service.getPublicRepoBranches('vercel/next.js'),
    ).resolves.toEqual([{ name: 'main', sha: 'abc' }]);
  });
});
