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
    // The third thing a guest is shown, after their own things and the instance
    // around them: what the platform's own operators run here, and since when.
    //
    // The permission was already granted — a tenancy is written a
    // `showcase_viewer` binding beside its own — and the fence was refusing the
    // route anyway, so the two halves disagreed and the outer one won. That is
    // the fence working as designed (an allowlist refuses what nobody named),
    // but it made the showcase unreadable by the only people it exists for.
    //
    // Named `/showcase`, not `/showcase/**`. Publishing and withdrawing are
    // `PUT` and `DELETE` one segment further down, and a wildcard here would
    // repeat the `/sandbox/**` mistake documented in `sandbox-fence-own.ts` —
    // opening, in advance, whatever gets mounted under this prefix next.
    // Reading is not being lent the thing: `showcase_viewer` carries `app:read`
    // alone, so a guest that did reach a write is refused a layer further in.
    verbs: ['GET'],
    pattern: '/showcase',
    level: 'read-only',
    why: 'See what Flui itself runs on this instance, and how long it has been up.',
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
  //
  // How this installation is run, in the words of the people who run it.
  //
  // The rules of a place descend to whoever acts there, and a guest acts here:
  // it deploys real applications onto a real cluster whose practices it has no
  // other way of learning. Refusing these two left the notes readable only by
  // the people who wrote them.
  //
  // Real and never invented, and there is nothing to project. Every route
  // above that answers for the whole instance carries a projection because the
  // handler answers the same thing to everybody; this one does not — the
  // service resolves the caller's own grant first, so a tenancy is handed the
  // *practice* of the platform and of the cluster it sits on and never the
  // reasons behind a level it does not own. Narrowing the body a second time
  // out here would be a second copy of that boundary.
  //
  // Only the reads. Writing a note stays refused for a guest, and not by
  // accident: in the trial the platform teaches the visitor, not the other way
  // round.
  //
  // Three further reads are left out of this list, and each is a decision
  // rather than an oversight. `sandbox-fence.spec.ts` pins all three by name,
  // which is the only thing that keeps a refusal from decaying back into an
  // omission the moment somebody reads this list and not that one:
  //
  //  - `/operating-context/probes` and `/operating-context/reach` are an
  //    author's tools. The first is the catalogue a note's check is picked
  //    from; the second answers *who would read a note I am about to write at
  //    this level*, before it exists. A guest writes nothing, so both answer a
  //    question it does not have. Neither is withheld because it discloses
  //    anything: the catalogue publishes field names a guest already reads off
  //    its own application, and the reach line is a pure function of two words
  //    the caller supplied;
  //  - `/operating-context/archive` is what was **withdrawn**. What carries
  //    the two rules above through this fence is that a guest acts here for
  //    real and should act by the rules in force — and a retired note is, by
  //    definition, not one of those. The archive answers *who do I ask before
  //    writing this rule again*, a question that belongs to whoever may write
  //    the rule; and the field that makes it answerable, the hand that
  //    withdrew it, is refused to a guest by the signature gate regardless. A
  //    guest would be handed the archive with its point removed.
  {
    verbs: ['GET'],
    pattern: '/operating-context',
    level: 'read-only',
    why: 'Read how this installation is run before you change anything on it.',
  },
  {
    verbs: ['GET'],
    pattern: '/operating-context/advice',
    level: 'read-only',
    why: 'Hand the agent you connected the local practice it is about to act against.',
  },
];
