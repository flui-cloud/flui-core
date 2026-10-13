import { SandboxAllowRule } from './sandbox-fence-core';

/**
 * Building from the guest's own GitHub repositories.
 *
 * The demo connects GitHub through the instance's App: the guest installs it on
 * their own account or organisation, picks the repositories it may see, and
 * Flui writes the build workflow and its secrets into those repositories. The
 * images go to the instance's own registry, so no token is pasted anywhere.
 * The token routes stay open for an instance that connects GitHub with tokens.
 * The workflow of an application already deployed is rewritten through that
 * application's own routes (`/applications/:id/**`, in the guest's own rules).
 *
 * Named route by route, never `/repositories/**`: a GET the fence admits skips
 * the permission check (`PermissionsGuard`), so a wildcard would also open the
 * instance's GitHub setup and every App installation on it. Each route here
 * answers from the caller's own rows, or with a credential GitHub itself places
 * the caller on: an installation token is minted only for an account GitHub
 * lists among the caller's installations (`GitHubInstallationAccessService`).
 *
 * Shut: creating, importing or resetting the App, its webhook, the list of
 * every installation on the instance and removing one, and storing a GHCR
 * token. GitHub's own calls (the install callback, the App webhook, the build
 * report) carry no guest session and are authenticated by their own state,
 * signature or per-application token, so the fence never sees them.
 */
export const SANDBOX_ALLOW_GIT: SandboxAllowRule[] = [
  {
    verbs: ['GET'],
    pattern: '/repositories/github/setup/status',
    why: 'See how this instance connects GitHub.',
  },
  {
    verbs: ['GET'],
    pattern: '/repositories/github/status',
    why: 'See whether your GitHub account is connected.',
  },
  {
    verbs: ['POST'],
    pattern: '/repositories/github/validate-pat',
    why: 'Check a GitHub token before you connect it, where this instance uses tokens.',
  },
  {
    verbs: ['POST'],
    pattern: '/repositories/github/connect-pat',
    why: 'Connect your GitHub account with your own token, where this instance uses tokens.',
  },
  {
    verbs: ['POST'],
    pattern: '/repositories/github/disconnect',
    why: 'Disconnect the GitHub token you connected.',
  },
  {
    verbs: ['POST'],
    pattern: '/repositories/github/test',
    why: 'Test your GitHub connection.',
  },
  {
    verbs: ['GET'],
    pattern: '/repositories/github-app/install-url',
    why: 'Install Flui on your GitHub account or organisation and choose the repositories it sees.',
  },
  {
    verbs: ['POST'],
    pattern: '/repositories/github-app/claim',
    why: 'Finish connecting GitHub, from the browser that started it.',
  },
  {
    // On an instance with its own registry the answer is "not needed", and the
    // screen after the install reads it to skip the step.
    verbs: ['GET'],
    pattern: '/repositories/github-app/packages-pat/status',
    why: 'See whether a container-registry token is needed; none is where images stay in this instance’s registry.',
  },
  {
    verbs: ['GET'],
    pattern: '/repositories/github-app/installations/mine',
    why: 'See the GitHub accounts and organisations you installed Flui on.',
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
    why: 'List the repositories you let Flui see on GitHub.',
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
      why: 'Prepare a repository you connected for deployment, and write its build workflow.',
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
