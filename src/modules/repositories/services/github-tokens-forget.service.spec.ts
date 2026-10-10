jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));

import { GitHubTokensForgetService } from './github-tokens-forget.service';

const table = (
  name: string,
  affected: number,
  log: Array<[string, unknown]>,
) => ({
  delete: async (where: unknown) => {
    log.push([`${name}.delete`, where]);
    return { affected };
  },
});

function harness(opts: {
  login?: string;
  sharedLogin?: boolean;
  installations?: Array<{
    installationId: number;
    accountLogin: string;
    accountType: string;
  }>;
}) {
  const log: Array<[string, unknown]> = [];
  const uninstalled: number[] = [];
  const service = new GitHubTokensForgetService(
    table('credentials', 1, log) as never,
    table('repositories', 2, log) as never,
    {
      ...table('userTokens', 0, log),
      findOne: async () => (opts.login ? { githubLogin: opts.login } : null),
      count: async () => (opts.sharedLogin ? 1 : 0),
    } as never,
    {
      update: async (where: unknown, patch: unknown) => {
        log.push(['installations.update', { where, patch }]);
      },
    } as never,
    {
      uninstall: async (id: number) => {
        uninstalled.push(id);
      },
    } as never,
    {
      ownAccountInstallationIds: async () =>
        (opts.installations ?? [])
          .filter(
            (i) =>
              i.accountType === 'User' &&
              i.accountLogin === opts.login?.toLowerCase(),
          )
          .map((i) => i.installationId),
    } as never,
  );
  return { service, log, uninstalled };
}

describe('forgetting a person’s GitHub access', () => {
  it('removes the credential, every connected repository’s copy and the App sign-in, by that person only', async () => {
    const { service, log } = harness({});
    await expect(service.forget('u1')).resolves.toBe(3);
    expect(log).toEqual(
      expect.arrayContaining([
        ['credentials.delete', { userId: 'u1' }],
        ['repositories.delete', { userId: 'u1' }],
        ['userTokens.delete', { fluiUserId: 'u1' }],
        [
          'installations.update',
          { where: { userId: 'u1' }, patch: { userId: null } },
        ],
      ]),
    );
  });

  it('takes the App off the person’s own GitHub account, and leaves an organisation’s', async () => {
    const { service, uninstalled } = harness({
      login: 'Guest-One',
      installations: [
        { installationId: 11, accountLogin: 'guest-one', accountType: 'User' },
        {
          installationId: 22,
          accountLogin: 'guest-one',
          accountType: 'Organization',
        },
        {
          installationId: 33,
          accountLogin: 'someone-else',
          accountType: 'User',
        },
      ],
    });
    await service.forget('u1');
    expect(uninstalled).toEqual([11]);
  });

  it('leaves the App installed when another Flui user signs in as the same GitHub account', async () => {
    const { service, uninstalled } = harness({
      login: 'guest-one',
      sharedLogin: true,
      installations: [
        { installationId: 11, accountLogin: 'guest-one', accountType: 'User' },
      ],
    });
    await service.forget('u1');
    expect(uninstalled).toEqual([]);
  });
});
