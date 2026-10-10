jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));

import { Logger } from '@nestjs/common';
import { GithubAppUserAuthService } from './github-app-user-auth.service';

describe('rescanning the installations a GitHub user can see', () => {
  const rescan = async (existing: { userId: string | null } | null) => {
    const saved: Array<Record<string, unknown>> = [];
    const service = Object.create(GithubAppUserAuthService.prototype) as {
      installationRepo: unknown;
      logger: Logger;
      persistAccessibleInstallations: (
        o: unknown,
        u: string,
        l: string,
      ) => Promise<number[]>;
    };
    service.logger = new Logger('test');
    service.installationRepo = {
      findOne: async () =>
        existing
          ? { installationId: 7, accountLogin: 'acme', ...existing }
          : null,
      create: (row: Record<string, unknown>) => row,
      save: async (row: Record<string, unknown>) => {
        saved.push(row);
        return row;
      },
    };
    await service.persistAccessibleInstallations(
      {
        apps: {
          listInstallationsForAuthenticatedUser: async () => ({
            data: {
              installations: [
                { id: 7, account: { login: 'acme', type: 'Organization' } },
              ],
            },
          }),
        },
      },
      'guest',
      'guest-login',
    );
    return saved[0];
  };

  it('does not take an installation over from the person who connected it', async () => {
    expect((await rescan({ userId: 'operator' })).userId).toBe('operator');
  });

  it('attributes one nobody had yet', async () => {
    expect((await rescan({ userId: null })).userId).toBe('guest');
    expect((await rescan(null)).userId).toBe('guest');
  });
});
