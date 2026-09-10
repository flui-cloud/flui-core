// `RepoTreeReaderService` is decorated (`@Injectable()`), so TS emits a real
// import of `GitHubTokenResolverService` for design-time metadata even though
// this spec only ever casts a stub to its type. That import chain reaches
// `@octokit/rest` (ESM-only), so it is stubbed the same way the repositories
// module's own specs already do.
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));

import { detect } from '@flui-cloud/cartographer';
import { RepoTreeReaderService } from './repo-tree-reader.service';
import { buildTarGz } from './repo-archive-scan.fixtures';
import type { GitHubTokenResolverService } from '../../repositories/services/github-token-resolver.service';

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

function fakeOctokit(gz: Buffer, commitSha: string) {
  return {
    repos: {
      getCommit: async () => ({ data: { sha: commitSha } }),
      downloadTarballArchive: async () => ({ data: toArrayBuffer(gz) }),
    },
  };
}

/**
 * The demonstration this piece exists to produce: from inside flui-core, read
 * a repository through the same GitHub credential the rest of the product
 * uses, and hand the result straight to cartographer's own `detect` — no
 * clone, no controller, nothing wired into the checks yet.
 */
describe('RepoTreeReaderService — cartographer wiring', () => {
  it('reads an archive via the token resolver and produces facts cartographer computed', async () => {
    const commitSha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const gz = buildTarGz([
      {
        path: `octocat-hello-world-${commitSha.slice(0, 7)}/Dockerfile`,
        content: 'FROM alpine\nEXPOSE 8080\n',
      },
      {
        path: `octocat-hello-world-${commitSha.slice(0, 7)}/go.mod`,
        content: 'module x\n',
      },
    ]);
    const octokit = fakeOctokit(gz, commitSha);
    const tokenResolver = {
      getOctokit: async () => octokit,
    } as unknown as GitHubTokenResolverService;

    const reader = new RepoTreeReaderService(tokenResolver);
    const result = await reader.readTree(
      'user-1',
      'octocat',
      'hello-world',
      'main',
    );

    expect(result.read).toBe(true);
    if (result.read === false) return;
    expect(result.commitSha).toBe(commitSha);
    expect(result.scan.files.sort()).toEqual(['Dockerfile', 'go.mod']);
    expect(result.contentComplete).toBe(true);
    expect(result.skipped).toEqual({ symlinks: 0, oversize: 0, other: 0 });

    // The proof: cartographer's own detector, fed the scan this reader built.
    const detected = detect(result.scan);
    expect(detected.port).toEqual({ value: 8080, source: 'Dockerfile:EXPOSE' });
    expect(detected.language?.value).toBe('go');
  });

  it('reports no-credential rather than throwing when the resolver refuses', async () => {
    const tokenResolver = {
      getOctokit: async () => {
        throw new Error('no GitHub connection for this account');
      },
    } as unknown as GitHubTokenResolverService;

    const reader = new RepoTreeReaderService(tokenResolver);
    const result = await reader.readTree(
      'user-1',
      'octocat',
      'hello-world',
      'main',
    );

    expect(result).toEqual({
      read: false,
      reason: 'no-credential',
      repoFullName: 'octocat/hello-world',
      ref: 'main',
    });
  });

  it('reports not-found when the ref does not resolve to a commit', async () => {
    const octokit = {
      repos: {
        getCommit: async () => {
          const error: { status?: number; message: string } = new Error(
            'Not Found',
          );
          error.status = 404;
          throw error;
        },
        downloadTarballArchive: async () => {
          throw new Error('should not be called');
        },
      },
    };
    const tokenResolver = {
      getOctokit: async () => octokit,
    } as unknown as GitHubTokenResolverService;

    const reader = new RepoTreeReaderService(tokenResolver);
    const result = await reader.readTree(
      'user-1',
      'octocat',
      'ghost-repo',
      'no-such-ref',
    );

    expect(result).toEqual({
      read: false,
      reason: 'not-found',
      repoFullName: 'octocat/ghost-repo',
      ref: 'no-such-ref',
    });
  });

  it('rejects the whole read when the archive carries a path escaping its root', async () => {
    const commitSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const gz = buildTarGz([
      {
        path: `octocat-hello-world-${commitSha.slice(0, 7)}/../../etc/passwd`,
        content: 'x',
      },
    ]);
    const octokit = fakeOctokit(gz, commitSha);
    const tokenResolver = {
      getOctokit: async () => octokit,
    } as unknown as GitHubTokenResolverService;

    const reader = new RepoTreeReaderService(tokenResolver);
    const result = await reader.readTree(
      'user-1',
      'octocat',
      'hello-world',
      'main',
    );

    expect(result).toEqual({
      read: false,
      reason: 'rejected',
      repoFullName: 'octocat/hello-world',
      ref: 'main',
    });
  });
});
