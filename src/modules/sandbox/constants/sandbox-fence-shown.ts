import { SandboxAllowRule } from './sandbox-fence-core';

/**
 * Shown, real, and never changed.
 *
 * The instance around the guest — the cluster their applications actually run
 * on, the certificate actually issued on their name — plus the two calls every
 * screen makes about the assistant, which answer the same thing to everybody.
 *
 * This is the half of the demo that proves the thing is real: nodes that are
 * genuinely up, a certificate that was genuinely issued. Every rule here that
 * answers for the whole instance carries a projection in SANDBOX_PROJECTIONS —
 * being allowed to see a cluster is not being allowed to see every cluster.
 */
export const SANDBOX_ALLOW_SHOWN: SandboxAllowRule[] = [
  //
  // Shown, never changed, and labelled as such. This is the half of the demo
  // that proves the thing is real — a cluster with nodes that are actually up,
  // and a certificate that was actually issued. Every one of these answers for
  // the whole instance, so every one carries a projection.
  {
    verbs: ['GET'],
    pattern: '/infrastructure/clusters/:id',
    level: 'read-only',
    why: 'Look at the cluster your applications run on.',
  },
  {
    verbs: ['GET'],
    pattern: '/infrastructure/clusters/:id/nodes',
    level: 'read-only',
    why: 'See how many machines are under you and whether they are healthy.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/clusters/:clusterId/metrics',
    level: 'read-only',
    why: 'See how the cluster you are on is doing.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/clusters/:clusterId/metrics/history',
    level: 'read-only',
    why: 'See how the cluster you are on has been doing.',
  },
  {
    verbs: ['GET'],
    pattern: '/clusters/:clusterId/endpoints',
    level: 'read-only',
    why: 'Watch the public name and certificate of your own applications.',
  },
  {
    verbs: ['GET'],
    pattern: '/clusters/:clusterId/dns-zone/system-status',
    level: 'read-only',
    why: 'See that the instance really does terminate TLS.',
  },
  {
    verbs: ['GET'],
    pattern: '/clusters/:clusterId/dns-zone/list',
    level: 'read-only',
    why: 'See the zone your applications are published under, and its certificate.',
  },
  {
    // The provider's own logo, a static file shipped with the release. It is
    // declared `@Public()` on its controller, but the fence sees an
    // authenticated guest and was refusing it — which left the Providers screen
    // with a broken image where the example account's provider should be.
    verbs: ['GET'],
    pattern: '/management/providers/:provider/logo',
    level: 'read-only',
    why: 'Show the provider it is.',
  },
  {
    // The three migration lists each answer with the caller's *own* migrations
    // — `list(userId)` in every one of the three services — so this is a real
    // read with nothing to project. A guest cannot start one (the fence refuses
    // the POST), so what it sees today is an empty table. The showcase that
    // would fill it is a separate, deliberate act.
    verbs: ['GET'],
    pattern: '/app-migrations',
    level: 'read-only',
    why: 'See migrations across clusters, as they are recorded.',
  },
  {
    verbs: ['GET'],
    pattern: '/db-migrations',
    level: 'read-only',
    why: 'See managed-database migrations, as they are recorded.',
  },
  {
    verbs: ['GET'],
    pattern: '/full-migrations',
    level: 'read-only',
    why: 'See whole-application migrations, as they are recorded.',
  },
  // Read-only, and real: both answer the same thing to everybody. `info` is the
  // assistant's name and knowledge-base version, `recommendations` is a file
  // shipped with the release. Neither reads the instance or anyone's data, and
  // both are asked on every screen — refusing them filled a guest's console
  // with errors that said "broken product" rather than "limited demo".
  {
    verbs: ['GET'],
    pattern: '/assistant/v1/info',
    level: 'read-only',
    why: 'Know the assistant is there and what it is built on.',
  },
  {
    verbs: ['GET'],
    pattern: '/assistant/v1/recommendations',
    level: 'read-only',
    why: 'See which models Flui recommends for the assistant.',
  },
];
