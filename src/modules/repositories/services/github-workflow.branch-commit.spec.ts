// `GitHubWorkflowService` is decorated, so TS emits real imports of everything
// its constructor names — including the token resolver's `@octokit/rest`
// (ESM-only) chain. Stubbed the way the other specs in this module already do.
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { GitHubWorkflowService } from './github-workflow.service';
import type { GitHubOAuthService } from './github-oauth.service';
import type { GitHubTokenResolverService } from './github-token-resolver.service';

const BASE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TREE_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NEW_TREE_SHA = 'cccccccccccccccccccccccccccccccccccccccc';
const NEW_COMMIT_SHA = 'dddddddddddddddddddddddddddddddddddddddd';

function octokitStub(overrides: { createRef?: jest.Mock } = {}) {
  return {
    git: {
      getRef: jest
        .fn()
        .mockResolvedValue({ data: { object: { sha: BASE_SHA } } }),
      getCommit: jest
        .fn()
        .mockResolvedValue({ data: { tree: { sha: TREE_SHA } } }),
      createTree: jest.fn().mockResolvedValue({ data: { sha: NEW_TREE_SHA } }),
      createCommit: jest
        .fn()
        .mockResolvedValue({ data: { sha: NEW_COMMIT_SHA } }),
      updateRef: jest.fn().mockResolvedValue({ data: {} }),
      createRef:
        overrides.createRef ?? jest.fn().mockResolvedValue({ data: {} }),
      deleteRef: jest.fn().mockResolvedValue({ data: {} }),
    },
  };
}

function serviceWith(octokit: ReturnType<typeof octokitStub>) {
  const assertCapability = jest.fn().mockResolvedValue(undefined);
  const resolver = {
    assertCapability,
    getOctokit: jest.fn().mockResolvedValue(octokit),
  } as unknown as GitHubTokenResolverService;
  const service = new GitHubWorkflowService({} as GitHubOAuthService, resolver);
  return { service, assertCapability };
}

describe('GitHubWorkflowService — cutting a branch', () => {
  it('cuts at the sha it was given, without asking where the branch points now', async () => {
    // The caller's sha is the commit the map read and rendered every manifest
    // from. Resolving the branch again here would resolve a second, possibly
    // different commit — and then the manifests, the branch name and the
    // reported `baseCommitSha` would each describe a different tree.
    const octokit = octokitStub();
    // A branch that has already moved: if this value ever reaches the ref, the
    // apply committed onto a commit its manifests were not rendered from.
    octokit.git.getRef.mockResolvedValue({
      data: { object: { sha: 'ffffffffffffffffffffffffffffffffffffffff' } },
    });
    const { service, assertCapability } = serviceWith(octokit);

    const result = await service.createBranchFrom(
      'user-1',
      'acme',
      'shop',
      'flui/deploy-aaaaaaa',
      BASE_SHA,
    );

    expect(assertCapability).toHaveBeenCalledWith('user-1', [
      'repo',
      'workflow',
    ]);
    expect(octokit.git.getRef).not.toHaveBeenCalled();
    expect(octokit.git.createRef).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: 'refs/heads/flui/deploy-aaaaaaa',
        sha: BASE_SHA,
      }),
    );
    // The lock is a ref, not a commit: nothing was written and no workflow ran.
    expect(octokit.git.createCommit).not.toHaveBeenCalled();
    expect(octokit.git.updateRef).not.toHaveBeenCalled();
    expect(result).toEqual({ head: 'flui/deploy-aaaaaaa', baseSha: BASE_SHA });
  });

  it('refuses, rather than falling back to the branch tip, when given no sha', async () => {
    const octokit = octokitStub();
    const { service } = serviceWith(octokit);

    await expect(
      service.createBranchFrom('u', 'acme', 'shop', 'flui/deploy-aaa', ''),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(octokit.git.getRef).not.toHaveBeenCalled();
    expect(octokit.git.createRef).not.toHaveBeenCalled();
  });

  it('refuses with a conflict when the Flui branch already exists', async () => {
    const createRef = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Reference already exists'), { status: 422 }),
      );
    const { service } = serviceWith(octokitStub({ createRef }));

    await expect(
      service.createBranchFrom(
        'u',
        'acme',
        'shop',
        'flui/deploy-aaa',
        BASE_SHA,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses with a forbidden when the credential cannot write', async () => {
    const createRef = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Not Found'), { status: 404 }),
      );
    const { service } = serviceWith(octokitStub({ createRef }));

    await expect(
      service.createBranchFrom(
        'u',
        'acme',
        'shop',
        'flui/deploy-aaa',
        BASE_SHA,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('GitHubWorkflowService — one commit, many files', () => {
  const files = [
    { path: 'flui.yaml', content: 'kind: Application\n' },
    { path: 'api/flui.yaml', content: 'kind: Application\nname: api\n' },
    { path: '.github/workflows/flui-api.yml', content: 'on:\n  push:\n' },
  ];

  it('puts every file in one tree and advances the Flui branch once', async () => {
    const octokit = octokitStub();
    const { service } = serviceWith(octokit);

    const result = await service.commitFilesOnBranch(
      'user-1',
      'acme',
      'shop',
      'flui/deploy-aaaaaaa',
      files,
      { message: 'chore(flui): deploy 2 applications' },
    );

    // One tree carrying all three blobs, stacked on the branch's own base tree.
    expect(octokit.git.createTree).toHaveBeenCalledTimes(1);
    const tree = octokit.git.createTree.mock.calls[0][0];
    expect(tree.base_tree).toBe(TREE_SHA);
    expect(tree.tree).toEqual([
      {
        path: 'flui.yaml',
        mode: '100644',
        type: 'blob',
        content: 'kind: Application\n',
      },
      {
        path: 'api/flui.yaml',
        mode: '100644',
        type: 'blob',
        content: 'kind: Application\nname: api\n',
      },
      {
        path: '.github/workflows/flui-api.yml',
        mode: '100644',
        type: 'blob',
        content: 'on:\n  push:\n',
      },
    ]);

    // One commit, and the ref that moves is Flui's own branch — never the base.
    expect(octokit.git.createCommit).toHaveBeenCalledTimes(1);
    expect(octokit.git.updateRef).toHaveBeenCalledTimes(1);
    expect(octokit.git.updateRef).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: 'heads/flui/deploy-aaaaaaa',
        sha: NEW_COMMIT_SHA,
      }),
    );
    expect(result.sha).toBe(NEW_COMMIT_SHA);
    expect(result.files).toEqual([
      'flui.yaml',
      'api/flui.yaml',
      '.github/workflows/flui-api.yml',
    ]);
  });

  it('refuses an empty commit rather than moving a ref for nothing', async () => {
    const octokit = octokitStub();
    const { service } = serviceWith(octokit);

    await expect(
      service.commitFilesOnBranch('u', 'acme', 'shop', 'flui/x', [], {
        message: 'nothing',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(octokit.git.createTree).not.toHaveBeenCalled();
  });
});
