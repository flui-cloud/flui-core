// The service constructs a real Octokit; @octokit/rest ships ESM only, so the
// suite swaps it for a stub that reports what GitHub would answer.
let githubAnswer: { installations: { id: number }[] } | Error = {
  installations: [],
};
let githubCalls = 0;

jest.mock('@octokit/rest', () => ({
  Octokit: class {
    apps = {
      listInstallationsForAuthenticatedUser: async () => {
        githubCalls++;
        if (githubAnswer instanceof Error) throw githubAnswer;
        return { data: githubAnswer };
      },
    };
  },
}));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));

import {
  GitHubInstallationAccessService,
  INSTALLATION_REACH_TTL_MS,
} from './github-installation-access.service';
import { GitHubAppInstallationEntity } from '../entities/github-app-installation.entity';

const row = (
  over: Partial<GitHubAppInstallationEntity>,
): GitHubAppInstallationEntity =>
  ({
    id: 'row-id',
    installationId: 100,
    accountLogin: 'acme',
    accountType: 'Organization',
    userId: 'owner-user',
    repositorySelection: 'all',
    suspendedAt: null as unknown as Date,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as GitHubAppInstallationEntity;

/**
 * The question this service answers is "does GitHub place this user on this
 * installation", not "did this user's row create it". An installation on an
 * organization serves everyone in the organization, and only one of them is
 * the row.
 */
describe('GitHubInstallationAccessService', () => {
  const build = (
    rows: GitHubAppInstallationEntity[],
    token: { accessToken: string } | null = { accessToken: 'u2s' },
  ) => {
    githubCalls = 0;
    const repo = {
      find: async ({ where }: { where?: { accountLogin?: string } } = {}) =>
        where?.accountLogin
          ? rows.filter((r) => r.accountLogin === where.accountLogin)
          : rows,
    };
    const userAuth = { getValidToken: async () => token };
    return new GitHubInstallationAccessService(
      repo as never,
      userAuth as never,
    );
  };

  it('lets a stranger nowhere near an installation somebody else registered', async () => {
    githubAnswer = { installations: [] };
    const service = build([row({ installationId: 100, userId: 'operator' })]);

    expect(await service.findReachableByOwner('stranger', 'acme')).toBeNull();
  });

  it('lets an org member through on GitHub’s word, though the row is not theirs', async () => {
    githubAnswer = { installations: [{ id: 100 }] };
    const service = build([row({ installationId: 100, userId: 'operator' })]);

    const found = await service.findReachableByOwner('teammate', 'acme');
    expect(found?.installationId).toBe(100);
  });

  it('trusts its own row for the user who registered it, without asking GitHub', async () => {
    githubAnswer = { installations: [] };
    const service = build([row({ installationId: 100, userId: 'operator' })]);

    expect(
      (await service.findReachableByOwner('operator', 'acme'))?.installationId,
    ).toBe(100);
    expect(githubCalls).toBe(0);
  });

  it('matches the owner case-insensitively, as the table stores it lowercased', async () => {
    githubAnswer = { installations: [] };
    const service = build([row({ accountLogin: 'acme', userId: 'operator' })]);

    expect(
      await service.findReachableByOwner('operator', 'ACME'),
    ).not.toBeNull();
  });

  it('asks GitHub once for a whole import, not once per repository', async () => {
    githubAnswer = { installations: [{ id: 100 }] };
    const service = build([row({ installationId: 100, userId: 'operator' })]);

    for (let i = 0; i < 20; i++) {
      await service.findReachableByOwner('teammate', 'acme');
    }
    expect(githubCalls).toBe(1);
  });

  it('asks GitHub again once the declared window has passed', async () => {
    githubAnswer = { installations: [{ id: 100 }] };
    const service = build([row({ installationId: 100, userId: 'operator' })]);
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now');

    clock.mockReturnValue(now);
    await service.findReachableByOwner('teammate', 'acme');
    clock.mockReturnValue(now + INSTALLATION_REACH_TTL_MS + 1);
    await service.findReachableByOwner('teammate', 'acme');

    expect(githubCalls).toBe(2);
    clock.mockRestore();
  });

  it('reaches nothing when the user has no GitHub identity to ask with', async () => {
    githubAnswer = { installations: [{ id: 100 }] };
    const service = build(
      [row({ installationId: 100, userId: 'operator' })],
      null,
    );

    expect(await service.findReachableByOwner('tokenless', 'acme')).toBeNull();
    expect(githubCalls).toBe(0);
  });

  it('reaches nothing when GitHub refuses to answer, rather than falling open', async () => {
    githubAnswer = new Error('401 Bad credentials');
    const service = build([row({ installationId: 100, userId: 'operator' })]);

    expect(await service.findReachableByOwner('stranger', 'acme')).toBeNull();
  });

  it('compares installation ids across the bigint/string seam', async () => {
    githubAnswer = { installations: [{ id: 100 }] };
    const service = build([
      row({ installationId: '100' as unknown as number, userId: 'operator' }),
    ]);

    expect(
      await service.findReachableByOwner('teammate', 'acme'),
    ).not.toBeNull();
  });

  describe('listReachable', () => {
    it('keeps only what GitHub places the user on', async () => {
      githubAnswer = { installations: [{ id: 200 }] };
      const service = build([
        row({ installationId: 100, accountLogin: 'acme', userId: 'operator' }),
        row({ installationId: 200, accountLogin: 'beta', userId: 'operator' }),
        row({ installationId: 300, accountLogin: 'gamma', userId: 'teammate' }),
      ]);

      const logins = (await service.listReachable('teammate')).map(
        (r) => r.accountLogin,
      );
      expect(logins.sort()).toEqual(['beta', 'gamma']);
    });

    it('returns nothing for a user GitHub places nowhere', async () => {
      githubAnswer = { installations: [] };
      const service = build([
        row({ installationId: 100, accountLogin: 'acme', userId: 'operator' }),
      ]);

      expect(await service.listReachable('stranger')).toEqual([]);
    });
  });
});
