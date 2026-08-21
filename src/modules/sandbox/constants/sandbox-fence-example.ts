import { SandboxAllowRule } from './sandbox-fence-core';

/**
 * Answered from the example world instead of from the instance.
 *
 * Reachable so the section can be opened and looked at; the handler behind these
 * never runs for a guest — SANDBOX_STAND_INS answers first. Two reasons a route
 * ends up here rather than in `sandbox-fence-shown.ts`: the real thing belongs
 * to the instance being borrowed (providers, machines, networks, backups), or
 * the real thing is other people's data (the other guests and the operator in
 * Access, recipient addresses in Mail).
 *
 * Every object that comes back says it is an example, and no value shaped like a
 * secret is ever invented — see the header of `sandbox-world.ts`.
 *
 * The detail routes are here for the same reason the list routes are: a row that
 * opens onto a refusal is the same defect as a menu entry that does.
 */
export const SANDBOX_ALLOW_EXAMPLE: SandboxAllowRule[] = [
  //
  // Reachable so the section can be opened and looked at, and answered from
  // SANDBOX_STAND_INS instead of from the instance — the handler behind these
  // never runs for a guest. Every object says it is an example.
  {
    verbs: ['GET'],
    pattern: '/management/providers',
    level: 'stand-in',
    why: 'See how providers are connected, on an example account.',
  },
  {
    verbs: ['GET'],
    pattern: '/management/configurations',
    level: 'stand-in',
    why: 'See how a provider is configured, on an example account.',
  },
  {
    verbs: ['GET'],
    pattern: '/instances',
    level: 'stand-in',
    why: 'See what a fleet of machines looks like.',
  },
  {
    verbs: ['GET'],
    pattern: '/vnets',
    level: 'stand-in',
    why: 'See how private networking is laid out.',
  },
  {
    verbs: ['GET'],
    pattern: '/firewalls',
    level: 'stand-in',
    why: 'See how firewall rules are written and reconciled.',
  },
  {
    verbs: ['GET'],
    pattern: '/dns/zones',
    level: 'stand-in',
    why: 'See how a zone is registered and given a wildcard certificate.',
  },
  {
    verbs: ['GET'],
    pattern: '/backup-destinations',
    level: 'stand-in',
    why: 'See where backups are kept.',
  },
  {
    verbs: ['GET'],
    pattern: '/backup-policies',
    level: 'stand-in',
    why: 'See how a backup schedule is written.',
  },
  {
    verbs: ['GET'],
    pattern: '/restore-jobs',
    level: 'stand-in',
    why: 'See what a restore looks like after it has run.',
  },
  {
    verbs: ['GET'],
    pattern: '/backups/status',
    level: 'stand-in',
    why: 'See at a glance whether a cluster is protected.',
  },
  {
    verbs: ['GET'],
    pattern: '/backup-jobs/cluster/:clusterId',
    level: 'stand-in',
    why: 'See the runs a schedule has produced.',
  },
  {
    // Access is the section a person evaluating Flui asks about first, and the
    // real one is the list of the other guests and of the operator. So it is
    // shown as an example organisation and never as a filtered read: there is
    // no filter that makes other people's accounts safe to hand over.
    verbs: ['GET'],
    pattern: '/auth/users',
    level: 'stand-in',
    why: 'See how people are held in an organisation, on an example one.',
  },
  {
    verbs: ['GET'],
    pattern: '/iam/roles',
    level: 'stand-in',
    why: 'See the roles access is handed out with.',
  },
  {
    verbs: ['GET'],
    pattern: '/iam/grants',
    level: 'stand-in',
    why: 'See how a grant points a role at a set of resources.',
  },
  {
    verbs: ['GET'],
    pattern: '/iam/groups',
    level: 'stand-in',
    why: 'See how people are grouped.',
  },
  {
    verbs: ['GET'],
    pattern: '/iam/resources',
    level: 'stand-in',
    why: 'See what a grant can be pointed at.',
  },
  {
    verbs: ['GET'],
    pattern: '/iam/principals',
    level: 'stand-in',
    why: 'See who a grant can be given to.',
  },
  {
    verbs: ['GET'],
    pattern: '/mail/overview',
    level: 'stand-in',
    why: 'See how sending is going, on an example account.',
  },
  {
    verbs: ['GET'],
    pattern: '/mail/connections',
    level: 'stand-in',
    why: 'See how a mail provider is connected.',
  },
  {
    verbs: ['GET'],
    pattern: '/mail/events',
    level: 'stand-in',
    why: 'See what delivery, bounce and deferral look like.',
  },
  {
    verbs: ['GET'],
    pattern: '/mail/domains',
    level: 'stand-in',
    why: 'See SPF, DKIM and DMARC proved on a sending domain.',
  },
  {
    verbs: ['GET'],
    pattern: '/mail/readiness',
    level: 'stand-in',
    why: 'See what a provider still needs before it can send.',
  },
  {
    verbs: ['GET'],
    pattern: '/mail/suppressions',
    level: 'stand-in',
    why: 'See how an address that bounced is held back.',
  },
  {
    verbs: ['GET'],
    pattern: '/inference/providers',
    level: 'stand-in',
    why: 'See which models the platform can talk to.',
  },
  {
    verbs: ['GET'],
    pattern: '/inference/connections',
    level: 'stand-in',
    why: 'See a model endpoint brought from outside. No key is ever shown.',
  },
  {
    // The detail behind a row of an example list. A row that opens onto a
    // refusal is the same defect as a menu entry that does — it says "broken"
    // where the caption was meant to say "limited" — so every list a screen
    // makes clickable has its element reachable too, from the same list.
    verbs: ['GET'],
    pattern: '/backup-policies/:id',
    level: 'stand-in',
    why: 'Open one of the example schedules.',
  },
  {
    verbs: ['GET'],
    pattern: '/backup-destinations/:id',
    level: 'stand-in',
    why: 'Open the example destination.',
  },
  {
    verbs: ['GET'],
    pattern: '/restore-jobs/:id',
    level: 'stand-in',
    why: 'Open the example restore.',
  },
  {
    verbs: ['GET'],
    pattern: '/backup-jobs/:id',
    level: 'stand-in',
    why: 'Open one of the example runs.',
  },
  {
    verbs: ['GET'],
    pattern: '/vnets/:id',
    level: 'stand-in',
    why: 'Open the example private network.',
  },
  {
    verbs: ['GET'],
    pattern: '/firewalls/:id',
    level: 'stand-in',
    why: 'Open the example firewall and its rules.',
  },
  {
    verbs: ['GET'],
    pattern: '/dns/zones/:id',
    level: 'stand-in',
    why: 'Open the example zone.',
  },
  {
    verbs: ['GET'],
    pattern: '/management/providers/:provider',
    level: 'stand-in',
    why: 'Open the example provider.',
  },
  {
    verbs: ['GET'],
    pattern: '/auth/users/:id',
    level: 'stand-in',
    why: 'Open one of the example people.',
  },
  {
    verbs: ['GET'],
    pattern: '/management/providers/:provider/regions',
    level: 'stand-in',
    why: 'See where the example provider can place machines.',
  },
  {
    verbs: ['GET'],
    pattern: '/mail/connections/:id/setup',
    level: 'stand-in',
    why: 'See the proofs a sending domain needs, published on the example one.',
  },
  {
    // Asked on every screen, to decide whether the credentials banner appears.
    // The real answer is the operator's own credential health; a tenancy holds
    // none of its own, so the stand-in answers "nothing to flag".
    verbs: ['GET'],
    pattern: '/credentials/status',
    level: 'stand-in',
    why: 'Nothing here needs your attention \u2014 a trial holds no credentials of its own.',
  },
];
