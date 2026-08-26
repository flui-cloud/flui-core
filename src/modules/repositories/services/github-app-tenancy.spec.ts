// The import graph reaches the ESM-only Octokit packages; every client used
// here is a stub, so the real ones are never constructed.
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { GitHubAppService } from './github-app.service';
import { GitHubTokenResolverService } from './github-token-resolver.service';
import { RepositoriesService } from './repositories.service';

const MODULE_ROOT = join(__dirname, '..');

const sourceFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))
        out.push(full);
    }
  };
  walk(MODULE_ROOT);
  return out;
};

const filesMatching = (pattern: RegExp): string[] =>
  sourceFiles()
    .filter((f) => pattern.test(readFileSync(f, 'utf8')))
    .map((f) => relative(MODULE_ROOT, f))
    .sort();

/**
 * In GitHub App mode the `owner` of a repository arrives in a request body.
 * Until this was pinned, naming an owner was enough to be handed an
 * installation token for that account — the caller's identity never entered
 * the query. These tests exist to redden the moment that shortcut comes back.
 */
describe('GitHub App installations are resolved per caller', () => {
  describe('the query itself', () => {
    it('never looks an installation up by account login alone', () => {
      // The only place allowed to select on `accountLogin` is the service that
      // immediately checks the caller reaches what it found. Re-adding
      // `where: { accountLogin: owner.toLowerCase() }` anywhere else — most of
      // all in github-app.service.ts — reopens the leak, and reddens here.
      expect(filesMatching(/where:\s*\{[^}]*accountLogin/)).toEqual([
        'services/github-installation-access.service.ts',
      ]);
    });

    it('reads the whole installations table only for the admin route', () => {
      expect(filesMatching(/listInstallations\(\)/)).toEqual([
        'controllers/github-app-oauth.controller.ts',
        'services/github-app.service.ts',
      ]);
    });
  });

  describe('GitHubAppService.resolveInstallationId', () => {
    const build = (reachable: string[]) =>
      new GitHubAppService(
        { getConfig: async () => ({ appSlug: 'flui-cloud' }) } as never,
        {} as never,
        {} as never,
        {
          findReachableByOwner: async (_userId: string, owner: string) =>
            reachable.includes(owner)
              ? { installationId: 42, accountLogin: owner }
              : null,
        } as never,
      );

    it('refuses an owner the caller does not reach', async () => {
      await expect(
        build([]).resolveInstallationId('stranger', 'acme'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses as absence, not as prohibition', async () => {
      // A 403 tells a stranger the account is onboarded here. The refusal for
      // "not yours" must read exactly like the refusal for "never heard of it".
      const service = build([]);
      const notYours = await service
        .resolveInstallationId('stranger', 'acme')
        .catch((e) => e);
      const unknown = await service
        .resolveInstallationId('stranger', 'never-seen-here')
        .catch((e) => e);

      expect(notYours).not.toBeInstanceOf(ForbiddenException);
      expect(notYours.getStatus()).toBe(unknown.getStatus());
      expect(notYours.message.replace('acme', 'never-seen-here')).toBe(
        unknown.message,
      );
    });

    it('serves the caller who does reach it', async () => {
      await expect(
        build(['acme']).resolveInstallationId('teammate', 'acme'),
      ).resolves.toBe(42);
    });

    it('never mints a token for an owner the caller does not reach', async () => {
      await expect(
        build([]).getInstallationToken('stranger', 'acme'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('GitHubTokenResolverService', () => {
    const build = (appMode: boolean) => {
      const seen: unknown[][] = [];
      const resolver = new GitHubTokenResolverService(
        {
          getOctokit: async (userId: string) => {
            seen.push(['oauth-octokit', userId]);
            return {} as never;
          },
          getAccessToken: async (userId: string) => {
            seen.push(['oauth-token', userId]);
            return 'personal';
          },
        } as never,
        {
          isEnabled: async () => appMode,
          getInstallationOctokit: async (userId: string, owner: string) => {
            seen.push(['app-octokit', userId, owner]);
            return {} as never;
          },
          getInstallationToken: async (userId: string, owner: string) => {
            seen.push(['app-token', userId, owner]);
            return 'installation';
          },
        } as never,
      );
      return { resolver, seen };
    };

    it('carries the caller down into the installation lookup', async () => {
      const { resolver, seen } = build(true);
      await resolver.getOctokit('u1', 'acme');
      await resolver.getAccessToken('u1', 'acme');

      expect(seen).toEqual([
        ['app-octokit', 'u1', 'acme'],
        ['app-token', 'u1', 'acme'],
      ]);
    });

    it('leaves the OAuth/PAT path exactly as it was — the token is already the user’s', async () => {
      const { resolver, seen } = build(false);
      await resolver.getOctokit('u1', 'acme');
      await resolver.getAccessToken('u1', 'acme');

      expect(seen).toEqual([
        ['oauth-octokit', 'u1'],
        ['oauth-token', 'u1'],
      ]);
    });
  });

  describe('RepositoriesService.listAvailableRepositories', () => {
    const build = (reachable: { accountLogin: string; repo: string }[]) => {
      const asked: string[] = [];
      const githubAppService = {
        isEnabled: async () => true,
        listReachableInstallations: async (userId: string) => {
          asked.push(userId);
          return reachable.map((r) => ({ accountLogin: r.accountLogin }));
        },
        getInstallationOctokit: async (_userId: string, owner: string) => ({
          apps: {
            listReposAccessibleToInstallation: async () => ({
              data: {
                repositories: reachable
                  .filter((r) => r.accountLogin === owner)
                  .map((r) => ({
                    id: 1,
                    name: r.repo,
                    full_name: `${owner}/${r.repo}`,
                    owner: { login: owner },
                    description: '',
                    default_branch: 'main',
                    private: true,
                    clone_url: '',
                    html_url: '',
                    language: '',
                    updated_at: new Date().toISOString(),
                  })),
              },
            }),
          },
        }),
      };
      const service = new RepositoriesService(
        { findByUserId: async () => [] } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        githubAppService as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      return { service, asked };
    };

    it('offers a user only the accounts they reach, not every account on the instance', async () => {
      const { service, asked } = build([
        { accountLogin: 'beta', repo: 'mine' },
      ]);

      const names = (await service.listAvailableRepositories('teammate')).map(
        (r) => r.fullName,
      );
      expect(names).toEqual(['beta/mine']);
      expect(asked).toEqual(['teammate']);
    });
  });
});
