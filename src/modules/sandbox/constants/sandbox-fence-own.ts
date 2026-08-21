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
    verbs: ['GET', 'PATCH'],
    pattern: '/applications/:id',
    why: 'Read and change your own application.',
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
    verbs: ['GET'],
    pattern: '/catalog-installs/**',
    why: 'Follow an installation you started.',
  },
  {
    verbs: ['GET'],
    pattern: '/infrastructure/operations/:id',
    why: 'Follow the progress of something you started.',
  },
  {
    verbs: ['GET'],
    pattern: '/sandbox/**',
    why: 'Read your own tenancy: what is disabled, and how long you have left.',
  },
  {
    // The one write a guest is offered, and it changes nothing about the
    // tenancy: it mails the caller a way back into the one they are already in.
    verbs: ['POST'],
    pattern: '/sandbox/save',
    why: 'Mail yourself the way back into this sandbox.',
  },
];
