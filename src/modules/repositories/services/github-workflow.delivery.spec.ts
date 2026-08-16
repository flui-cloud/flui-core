// The service's import graph reaches @octokit/rest, which ships ESM only; the
// suite drives a stub client, so the real one is never constructed.
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { GitHubWorkflowService } from './github-workflow.service';

/**
 * Which branch the workflow commit lands on is a consent question, not a
 * technical one. A stranger clicking a button on a public demo has agreed to try
 * Flui; they have not agreed to let it write to their default branch.
 */
describe('GitHubWorkflowService delivery', () => {
  const build = () => {
    const calls: string[] = [];
    const octokit = {
      git: {
        getRef: async () => ({ data: { object: { sha: 'base-sha' } } }),
        getCommit: async () => ({ data: { tree: { sha: 'tree-sha' } } }),
        createTree: async () => ({ data: { sha: 'new-tree' } }),
        createCommit: async () => ({ data: { sha: 'abcdef1234567890' } }),
        createRef: async ({ ref }: { ref: string }) => {
          calls.push(`createRef ${ref}`);
          return { data: {} };
        },
        updateRef: async ({ ref }: { ref: string }) => {
          calls.push(`updateRef ${ref}`);
          return { data: {} };
        },
      },
      pulls: {
        create: async ({ base, head }: { base: string; head: string }) => {
          calls.push(`pr ${head} -> ${base}`);
          return {
            data: { number: 7, html_url: 'https://github.com/o/r/pull/7' },
          };
        },
      },
      repos: {
        getContent: async () => {
          throw new Error('not found');
        },
      },
    };

    const service = new GitHubWorkflowService(
      {} as never,
      {
        assertCapability: async () => undefined,
        getOctokit: async () => octokit,
      } as never,
    );
    return { service, calls };
  };

  it('pushes to the branch by default, as an owner connecting their own repo expects', async () => {
    const { service, calls } = build();
    const result = await service.commitWorkflowFiles(
      'u1',
      'o',
      'r',
      'main',
      'on: push',
    );

    expect(calls).toEqual(['updateRef heads/main']);
    expect(result.pullRequestUrl).toBeUndefined();
  });

  it('never touches the branch when asked to propose instead', async () => {
    const { service, calls } = build();
    const result = await service.commitWorkflowFiles(
      'u1',
      'o',
      'r',
      'main',
      'on: push',
      undefined,
      'pull-request',
    );

    expect(calls.some((c) => c.startsWith('updateRef'))).toBe(false);
    expect(calls[0]).toContain('createRef refs/heads/flui/deploy-workflow-');
    expect(calls[1]).toBe('pr flui/deploy-workflow-abcdef1 -> main');
    expect(result.pullRequestUrl).toBe('https://github.com/o/r/pull/7');
  });

  it('puts the commit on a branch named after it, so two attempts do not collide', async () => {
    const { service, calls } = build();
    await service.commitWorkflowFiles(
      'u1',
      'o',
      'r',
      'main',
      'on: push',
      undefined,
      'pull-request',
    );

    expect(calls[0]).toContain('abcdef1');
  });
});
