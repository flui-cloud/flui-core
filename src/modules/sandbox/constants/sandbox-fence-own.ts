import { SandboxAllowRule } from './sandbox-fence-core';

/**
 * What is the guest's own, with no difference from a paying instance.
 *
 * Their applications and databases, the catalogue they install from, the logs
 * and metrics of what they are running, and the handful of calls the interface
 * needs before it can render anything at all. This is the half of the demo that
 * is not a demo: it is the product.
 *
 * Per-application routes are listed as `**` on purpose: each one already passes
 * AppAccessGuard or AppOwnershipGuard, so a guest reaching them can only reach
 * its own application. The fence removes whole areas; ownership does the rest.
 */
export const SANDBOX_ALLOW_OWN: SandboxAllowRule[] = [
  {
    verbs: ['GET'],
    pattern: '/auth/me',
    why: 'Know who you are signed in as.',
  },
  {
    // `/me/...`, not `/iam/me/...`: MeController is mounted at the root even
    // though it lives in the IAM module, and the earlier pattern matched no
    // route at all — which refused a guest the two calls the sidebar and every
    // permission check in the interface depend on.
    verbs: ['GET'],
    pattern: '/me/**',
    why: 'Resolve which parts of the interface to show.',
  },
  { verbs: ['GET'], pattern: '/version', why: 'Show the platform version.' },
  { verbs: ['GET'], pattern: '/health/**', why: 'Liveness of the instance.' },
  {
    // The interface is built on the cluster list: without it, it has nothing to
    // ask for applications and shows a guest zero of everything it owns. What
    // comes back is projected to this tenancy's own cluster, with machine names
    // and addresses removed — see SANDBOX_PROJECTIONS.
    verbs: ['GET'],
    pattern: '/infrastructure/clusters',
    why: 'See the cluster your tenancy runs on.',
  },
  {
    // Answers for the whole instance, so it is projected to the projects that
    // hold an application of the guest's own.
    verbs: ['GET'],
    pattern: '/projects',
    why: 'Group your own workloads.',
  },
  {
    verbs: ['GET'],
    pattern: '/clusters/:clusterId/applications',
    why: 'List the applications you own.',
  },
  {
    // The shape the interface and the CLI actually render from — composed
    // installs collapsed into one entry. Allowing only the flat listing above
    // left every workload screen empty while the API answered 200 to a route
    // nothing calls. It filters by ownership exactly as the flat one does.
    verbs: ['GET'],
    pattern: '/clusters/:clusterId/applications/grouped',
    why: 'List the applications you own, bundles collapsed.',
  },
  {
    verbs: ['POST'],
    pattern: '/clusters/:clusterId/applications',
    why: 'Create an application of your own.',
  },
  {
    verbs: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    pattern: '/applications/:id/**',
    why: 'Operate your own application — logs, metrics, deploys, its database console.',
  },
  {
    // DELETE is here on purpose, and it is the only destructive verb a guest
    // holds. The tenancy is a fixed quota: removing what you no longer need is
    // how you make room for the next thing, so refusing it would have made the
    // trial smaller the longer someone used it. Ownership is still decided by
    // AppAccessGuard, which asks for `app:delete` on that one application.
    verbs: ['GET', 'PATCH', 'DELETE'],
    pattern: '/applications/:id',
    why: 'Read, change and delete your own application.',
  },
  {
    // The denied-areas copy already promised these ("your application's own
    // variables are yours to edit") while the fence refused them. Both verbs now
    // pass AppAccessGuard, so a guest reaches its own application and no other.
    verbs: ['GET', 'PUT'],
    pattern: '/variables/applications/:appId',
    why: 'Read and change the variables of your own application.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/applications/:id/logs',
    why: 'Read logs selected from an application you may access.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/applications/:id/logs/volume',
    why: 'Chart log volume for an application you may access.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/applications/:id/metrics',
    why: 'Read resource metrics for an application you may access.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/applications/:id/metrics/history',
    why: 'Chart resource metrics for an application you may access.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/applications/:id/traffic',
    why: 'Read traffic metrics for an application you may access.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/applications/:id/traffic/history',
    why: 'Chart traffic metrics for an application you may access.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/applications/:id/alerts',
    why: 'Read alerts for an application you may access.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/clusters/:clusterId/applications/metrics',
    why: 'Read metrics filtered to applications you may access.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/clusters/:clusterId/applications/metrics/history',
    why: 'Chart metrics filtered to applications you may access.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/clusters/:clusterId/traffic',
    why: 'Read traffic filtered to applications you may access.',
  },
  {
    // Already reachable, and by anybody: the listing is `@Public()`, so the
    // fence never sees a user on it and never had a verdict to give. Named
    // here so the list stops disagreeing with the instance — the same list is
    // served to a guest as "what is available here", and a route it can call
    // but the list calls closed is the list lying. It grants nothing: the
    // detail route beside it is not public, and stays shut.
    verbs: ['GET'],
    pattern: '/templates',
    why: 'Browse the starting points you can deploy from.',
  },
  {
    verbs: ['GET'],
    pattern: '/catalog/**',
    why: 'Browse what you can install.',
  },
  { verbs: ['GET'], pattern: '/catalog', why: 'Browse what you can install.' },
  {
    verbs: ['POST'],
    pattern: '/catalog/:slug/install',
    why: 'Install a catalog application into your own tenancy.',
  },
  {
    // A POST that touches nothing: it reads a manifest out of the request and
    // answers whether it is well formed. Closed, it made an agent worse than a
    // text editor — the only way to find out whether a `flui.yaml` was valid
    // was to try to deploy it.
    verbs: ['POST'],
    pattern: '/catalog/validate',
    why: 'Check a manifest before you deploy it.',
  },
  {
    // "Is there room?", asked before installing rather than discovered by the
    // install failing. Already projected to the tenancy's own cluster.
    verbs: ['GET'],
    pattern: '/infrastructure/clusters/:clusterId/resource-availability',
    why: 'See whether your cluster has room for what you are about to install.',
  },
  {
    verbs: ['GET'],
    pattern: '/catalog-installs/**',
    why: 'Follow an installation you started.',
  },
  {
    // "You started" is now the route's own rule, not a hope of this list: the
    // handler refuses an operation whose owner is not the caller. The fence
    // used to be the only thing in the path, and it matched any id.
    verbs: ['GET'],
    pattern: '/infrastructure/operations/:id',
    why: 'Follow the progress of something you started.',
  },
  {
    // Named one by one, not `/sandbox/**`. The wildcard also opened
    // `/sandbox/capacity` — the shape of the instance — and
    // `/sandbox/tenancies`, which is every other guest's namespace: neither is
    // what the `why` below promises, and only `sandbox:operate` was stopping
    // them, one gate where the model wants two. Listed by name, a route added
    // under `/sandbox` later is closed until someone decides otherwise, which
    // is exactly how those two ended up inside.
    verbs: ['GET'],
    pattern: '/sandbox/limits',
    why: 'Read what is disabled here, and why.',
  },
  {
    verbs: ['GET'],
    pattern: '/sandbox/session',
    why: 'Read your own tenancy: how long you have left.',
  },
  {
    verbs: ['GET'],
    pattern: '/sandbox/resume',
    why: 'Come back into the tenancy you already have.',
  },
  {
    // The one write a guest is offered, and it changes nothing about the
    // tenancy: it mails the caller a way back into the one they are already in.
    verbs: ['POST'],
    pattern: '/sandbox/save',
    why: 'Mail yourself the way back into this sandbox.',
  },
  {
    // Connecting a coding agent, which is the thing the trial exists to show.
    // The key it mints is worth strictly less than the person minting it —
    // `api-key-scopes.ts` refuses any scope whose permission the issuer does
    // not hold, and a guest holds only its own applications — and every call
    // the agent then makes arrives back here, at this same list, as the guest.
    verbs: ['GET'],
    pattern: '/auth/api-key-groups',
    why: 'Read what you would be handing an agent, before you hand it over.',
  },
  {
    verbs: ['POST'],
    pattern: '/auth/api-keys',
    why: 'Give a coding agent a credential of your own to deploy with.',
  },
  {
    // The other half of the consent. Minting was open and revoking was not, so
    // the only way to switch an agent off was to wait for the tenancy to die.
    // Neither route hands over anybody else's key: the listing selects on the
    // caller's own id and the revoke matches on it too.
    verbs: ['GET'],
    pattern: '/auth/api-keys',
    why: 'See which agents you have given a key to.',
  },
  {
    verbs: ['DELETE'],
    pattern: '/auth/api-keys/:id',
    why: 'Switch off an agent you connected.',
  },
  {
    // Where the agent then speaks. Without it the credential above executes
    // nothing: the fence would refuse the agent at the door, and the failure
    // would arrive after the consent instead of before it. It opens no data of
    // its own — every tool behind it calls the API over HTTP as the guest, so
    // each call is matched against this same list a second time.
    verbs: ['POST'],
    pattern: '/mcp',
    why: 'Let the agent you connected act for you, inside these same limits.',
  },
  {
    // Answering your own agent's request. Without these lines the guest sees
    // the request and cannot say yes: deciding is a *write*, so the read-only
    // third state of a section does not reach it, and the trial stops at the
    // first thing the agent tries to do. Every row is filtered by owner, so
    // this opens nobody else's queue.
    verbs: ['GET'],
    pattern: '/agent/proposals',
    why: 'See what your agent is asking you to allow.',
  },
  {
    verbs: ['GET'],
    pattern: '/agent/proposals/:id',
    why: 'Read one request, and what allowing it always would concede.',
  },
  {
    verbs: ['POST'],
    pattern: '/agent/proposals/:id/decide',
    why: 'Answer your own agent: once, always, or no.',
  },
  {
    verbs: ['GET'],
    pattern: '/agent/concessions',
    why: 'See what your agent may already do without asking.',
  },
  {
    verbs: ['GET'],
    pattern: '/agent/concessions/:id/operations',
    why: 'See what is still running under a permission before taking it back.',
  },
  {
    verbs: ['DELETE'],
    pattern: '/agent/concessions/:id',
    why: 'Take a standing permission back, and ask what it started to stop.',
  },
];
