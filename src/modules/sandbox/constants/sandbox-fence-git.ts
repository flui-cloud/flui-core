import { SandboxAllowRule } from './sandbox-fence-core';

/**
 * Building from the guest's own GitHub repositories, with their own token.
 *
 * Named route by route, never `/repositories/**`: a GET the fence admits skips
 * the permission check (`PermissionsGuard`), so a wildcard would also open the
 * instance's GitHub setup and every App installation on it. Each route here
 * answers from the caller's own rows, or with the caller's own token.
 *
 * Of the GitHub App routes only the guest's own connection is open: the link
 * that installs the App on their account (its `state` names them) and the
 * rescan of what their own GitHub token reaches, and whether a GHCR token is
 * needed. The instance's installations and the routes that store a GHCR token
 * stay shut.
 */
export const SANDBOX_ALLOW_GIT: SandboxAllowRule[] = [
  {
    verbs: ['GET'],
    pattern: '/repositories/github/setup/status',
    why: 'See whether this instance connects GitHub with a token or an App.',
  },
  {
    verbs: ['GET'],
    pattern: '/repositories/github/status',
    why: 'See whether your GitHub account is connected.',
  },
  {
    verbs: ['POST'],
    pattern: '/repositories/github/validate-pat',
    why: 'Check a GitHub token before you connect it.',
  },
  {
    verbs: ['POST'],
    pattern: '/repositories/github/connect-pat',
    why: 'Connect your GitHub account with your own token.',
  },
  {
    verbs: ['POST'],
    pattern: '/repositories/github/disconnect',
    why: 'Disconnect your GitHub account.',
  },
  {
    verbs: ['POST'],
    pattern: '/repositories/github/test',
    why: 'Test your GitHub connection.',
  },
  {
    verbs: ['GET'],
    pattern: '/repositories/github-app/install-url',
    why: 'Install Flui on your GitHub account, in one click.',
  },
  {
    verbs: ['POST'],
    pattern: '/repositories/github-app/claim',
    why: 'Finish connecting your GitHub account.',
  },
  {
    // The caller's own token status, and whether one is needed at all: on an
    // instance with its own registry the answer is no, and the screen after
    // the install reads it to skip the step.
    verbs: ['GET'],
    pattern: '/repositories/github-app/packages-pat/status',
    why: 'See whether a container-registry token is needed here.',
  },
  {
    verbs: ['POST'],
    pattern: '/repositories/github-app/rescan-installations',
    why: 'Pick up an installation you made on GitHub directly.',
  },
  {
    verbs: ['GET'],
    pattern: '/repositories/github/search/public',
    why: 'Find a public repository to start from.',
  },
  {
    verbs: ['GET'],
    pattern: '/repositories/github/public/branches',
    why: 'Pick a branch of a public repository.',
  },
  {
    verbs: ['POST'],
    pattern: '/repositories/github/public/analyze',
    why: 'See how a public repository would be built.',
  },
  {
    verbs: ['GET'],
    pattern: '/repositories',
    why: 'List the repositories you connected.',
  },
  {
    verbs: ['GET'],
    pattern: '/repositories/available',
    why: 'List the repositories your token can reach.',
  },
  {
    verbs: ['POST'],
    pattern: '/repositories/import',
    why: 'Connect one of your repositories.',
  },
  {
    verbs: ['GET', 'DELETE'],
    pattern: '/repositories/:id',
    why: 'Read or disconnect a repository you connected.',
  },
  ...(['branches', 'commits', 'check-dockerfile', 'manifests'] as const).map(
    (leaf): SandboxAllowRule => ({
      verbs: ['GET'],
      pattern: `/repositories/:id/${leaf}`,
      why: 'Read a repository you connected.',
    }),
  ),
  ...(['test', 'analyze', 'extract-env', 'map', 'map/apply'] as const).map(
    (leaf): SandboxAllowRule => ({
      verbs: ['POST'],
      pattern: `/repositories/:id/${leaf}`,
      why: 'Prepare a repository you connected for deployment.',
    }),
  ),
  {
    // The cluster in the body is pinned to the guest's own area by the slot
    // gate in `assertCanCreate`, and the project they name is dropped.
    verbs: ['POST'],
    pattern: '/applications/deploy-from-yaml',
    why: 'Deploy your own repository from its flui.yaml.',
  },
  {
    verbs: ['POST'],
    pattern: '/templates/:framework/use',
    why: 'Start a new repository in your GitHub account from a template.',
  },
];
