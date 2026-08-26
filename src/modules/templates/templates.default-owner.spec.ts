// The import graph reaches the ESM-only Octokit packages; every client here is
// a stub, so the real ones are never constructed.
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TemplatesService } from './templates.service';

const INSTALL_URL = 'https://github.com/apps/flui-cloud/installations/new';

/** The account that onboarded first — the operator, or another tenant. */
const FIRST_ROW = 'operator-private-account';

interface Built {
  service: TemplatesService;
  octokitCalls: unknown[][];
  createdOwners: string[];
  listedWholeTable: number;
}

const build = (opts: { appMode: boolean; reachable: string[] }): Built => {
  const octokitCalls: unknown[][] = [];
  const createdOwners: string[] = [];
  const state = { listedWholeTable: 0 };

  const octokit = {
    repos: {
      createUsingTemplate: async ({ owner }: { owner: string }) => {
        createdOwners.push(owner);
        return {
          data: {
            name: 'app',
            full_name: `${owner}/app`,
            html_url: `https://github.com/${owner}/app`,
            clone_url: `https://github.com/${owner}/app.git`,
            default_branch: 'main',
            private: true,
            owner: { login: owner },
          },
        };
      },
    },
    git: { getRef: async () => ({}) },
  };

  const service = new TemplatesService(
    { get: (_key: string, fallback: string) => fallback } as never,
    {
      getActiveCredential: async () => ({ githubUsername: 'oauth-account' }),
    } as never,
    {
      assertCapability: async () => undefined,
      getOctokit: async (...args: unknown[]) => {
        octokitCalls.push(args);
        return octokit as never;
      },
    } as never,
    {
      isEnabled: async () => opts.appMode,
      getInstallUrl: async () => INSTALL_URL,
      listInstallations: async () => {
        state.listedWholeTable++;
        return [{ accountLogin: FIRST_ROW }];
      },
      listReachableInstallations: async () =>
        opts.reachable.map((accountLogin) => ({ accountLogin })),
    } as never,
  );

  return {
    service,
    octokitCalls,
    createdOwners,
    get listedWholeTable() {
      return state.listedWholeTable;
    },
  } as Built;
};

/**
 * With no `owner` in the body, the default used to be the first row of the
 * installations table — an account belonging to whoever onboarded first. The
 * token resolver refuses to mint for it, but the name still reached the caller
 * through the error messages. These tests redden if that fallback returns.
 */
describe('POST /templates/:framework/use — the default owner', () => {
  it('picks an account the caller reaches, never the first row of the table', async () => {
    const built = build({ appMode: true, reachable: ['my-org'] });

    await built.service.useTemplate('u1', 'nextjs', { name: 'app' } as never);

    expect(built.createdOwners).toEqual(['my-org']);
    expect(built.listedWholeTable).toBe(0);
  });

  it('refuses when the caller reaches nothing, and names no other account', async () => {
    const built = build({ appMode: true, reachable: [] });

    const error = await built.service
      .useTemplate('stranger', 'nextjs', { name: 'app' } as never)
      .catch((e) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.message).toContain(INSTALL_URL);
    expect(error.message).not.toContain(FIRST_ROW);
    expect(built.createdOwners).toEqual([]);
  });

  it('refuses as absence, not as prohibition', async () => {
    // The caller is told what is missing and how to get it, never that
    // somebody else's account exists here and is off limits.
    const error = await build({ appMode: true, reachable: [] })
      .service.useTemplate('stranger', 'nextjs', { name: 'app' } as never)
      .catch((e) => e);

    expect(error).not.toBeInstanceOf(ForbiddenException);
    expect(error.getStatus()).toBe(404);
    expect(error.message.toLowerCase()).not.toContain('forbidden');
    expect(error.message.toLowerCase()).not.toContain('not allowed');
  });

  it('carries the caller down to the token resolver with the owner', async () => {
    const built = build({ appMode: true, reachable: ['my-org'] });

    await built.service.useTemplate('u1', 'nextjs', {
      name: 'app',
      owner: 'my-org',
    } as never);

    expect(built.octokitCalls).toEqual([['u1', 'my-org']]);
  });

  it('leaves the OAuth/PAT path exactly as it was', async () => {
    const built = build({ appMode: false, reachable: [] });

    await built.service.useTemplate('u1', 'nextjs', { name: 'app' } as never);

    expect(built.createdOwners).toEqual(['oauth-account']);
    expect(built.listedWholeTable).toBe(0);
  });

  it('never reads the whole installations table', () => {
    // A source pin, because the leak was one call, not one behaviour: reading
    // every row here is the leak, whatever is done with the result.
    const source = readFileSync(
      join(__dirname, 'templates.service.ts'),
      'utf8',
    );
    expect(source).not.toContain('listInstallations(');
  });
});
