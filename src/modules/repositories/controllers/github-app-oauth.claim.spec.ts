jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { ForbiddenException } from '@nestjs/common';
import { GithubAppOAuthController } from './github-app-oauth.controller';
import { GithubAppInstallStateService } from '../services/github-app-install-state.service';

/**
 * F-093: the GitHub callback is opened by whatever browser follows the link,
 * so it connects nobody by itself; only the signed-in person who asked for the
 * link can finish it.
 */
describe('finishing a GitHub connection', () => {
  const memory = new Map<string, unknown>();
  const cache = {
    set: jest.fn(async (k: string, v: unknown) => void memory.set(k, v)),
    get: jest.fn(async (k: string) => memory.get(k) ?? null),
    delete: jest.fn(async (k: string) => void memory.delete(k)),
  };
  const stateStore = new GithubAppInstallStateService(cache as never);
  const userAuth = {
    exchangeCode: jest.fn().mockResolvedValue({ accessToken: 'gho_x' }),
    saveToken: jest
      .fn()
      .mockResolvedValue({ githubLogin: 'victim', installationId: '7' }),
  };
  const events = { emitGithubConnected: jest.fn() };
  const config = {
    get: jest.fn(() => 'https://dash.example/github/installed'),
  };
  const controller = new GithubAppOAuthController(
    stateStore,
    userAuth as never,
    events as never,
    config as never,
    {} as never,
    {} as never,
  );
  const as = (userId: string) => ({ user: { userId } }) as never;

  beforeEach(() => {
    memory.clear();
    jest.clearAllMocks();
  });

  const followLink = async (issuer: string) => {
    const state = await stateStore.issue(issuer);
    const res = { redirect: jest.fn() };
    await controller.callback('gh-code', state, '7', 'install', res as never);
    return new URL(res.redirect.mock.calls[0][0]).searchParams.get('claim');
  };

  it('saves nothing when the browser comes back from GitHub', async () => {
    const claim = await followLink('guest');
    expect(claim).toBeTruthy();
    expect(userAuth.exchangeCode).not.toHaveBeenCalled();
    expect(userAuth.saveToken).not.toHaveBeenCalled();
  });

  it('refuses to connect a link sent to someone else', async () => {
    const claim = await followLink('guest');
    await expect(
      controller.claim(as('victim'), { claim }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(userAuth.saveToken).not.toHaveBeenCalled();
    await expect(controller.claim(as('guest'), { claim })).rejects.toThrow(
      /expired or was already finished/,
    );
  });

  it('connects the person who started it, once', async () => {
    const claim = await followLink('guest');
    await expect(controller.claim(as('guest'), { claim })).resolves.toEqual({
      login: 'victim',
      installationId: '7',
    });
    expect(userAuth.saveToken).toHaveBeenCalledWith(
      'guest',
      { accessToken: 'gho_x' },
      '7',
    );
    await expect(controller.claim(as('guest'), { claim })).rejects.toThrow(
      /expired or was already finished/,
    );
  });
});
