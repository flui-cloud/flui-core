/**
 * Every area of the product, and how much of it a guest gets.
 *
 * This is copy for a visitor, not authorization data — the rules that actually
 * decide anything are in `sandbox-fence-own|shown|example.ts`, and these two
 * must be kept saying the same thing. It lives on its own because it is edited
 * for a different reason: a fence rule changes when a route changes, this
 * changes when the explanation reads badly.
 *
 * Served from the API rather than hard-coded in the browser: the CLI and an
 * agent holding the guest's credential must be told the same thing the screen
 * says. `key` is the stable handle the interface matches on; the wording above
 * it may change freely.
 */
import { SHOWCASE_BANNER } from '../../applications/constants/showcase-banner';
import { SandboxLevel } from './sandbox-fence-core';

export interface SandboxArea {
  key: string;
  area: string;
  level: SandboxLevel;
  why: string;
}

export const SANDBOX_AREAS: SandboxArea[] = [
  {
    key: 'workloads',
    area: 'Your applications, databases and tools',
    level: 'full',
    why: 'Yours to deploy, scale, read and delete, exactly as on your own instance.',
  },
  {
    // Not a section of its own, and deliberately: these applications appear in
    // the workload list beside the guest's own, each one carrying
    // `showcase: true` and `readOnly: true`, because that is where a person
    // looks for a running application. The label is what keeps the two apart —
    // and the reason it has to be there is the same reason the seed declares
    // itself: something the visitor did not create, shown unlabelled, reads as
    // the leftovers of another guest.
    //
    // The sentence is the showcase's own, imported rather than restated, so the
    // showcase and the list of limits cannot end up promising different things.
    key: 'showcase',
    area: 'The applications Flui runs here',
    level: 'read-only',
    why: SHOWCASE_BANNER,
  },
  {
    key: 'catalog',
    area: 'The app catalogue',
    level: 'full',
    why: 'Install anything from it into your own space.',
  },
  {
    // Named even though nothing under `/repositories` is open, because the
    // list is also the answer to "what is disabled here": a limit nobody
    // states reads as a missing feature, and a visitor who is offered "deploy
    // your own application" and finds no way to reach a repository concludes
    // Flui cannot build from source.
    //
    // Not because building is dangerous — it never happens on this instance,
    // it happens on GitHub's runners. Because of what connecting costs on a
    // borrowed instance: where the installation runs as a GitHub App every
    // token is resolved by GitHub account and never by tenancy, so a guest
    // allowed to connect would be handed the instance's own installation
    // rather than its own. And what Flui writes back — a workflow carrying a
    // webhook token in clear text — is a trade to make on an instance you
    // keep.
    key: 'repositories',
    area: 'Building from your own git repository',
    level: 'closed',
    why: 'Connecting a repository would put a token on your GitHub account into an instance you are borrowing for a day, and write a workflow file back into your repository. Deploy from the catalogue, or from an image you have already built — both are fully yours here.',
  },
  {
    key: 'cluster',
    area: 'The cluster you are on',
    level: 'read-only',
    why: 'You can see how many nodes there are and how they are doing. It is shared, so changing one changes it for every guest on it.',
  },
  {
    key: 'certificates',
    area: 'Certificates and endpoints',
    level: 'read-only',
    why: 'Your applications get a real certificate on a real name — you can watch it happen. Pointing a domain you own at a machine you share is a door we keep shut.',
  },
  {
    key: 'providers',
    area: 'Cloud providers, servers and networks',
    level: 'stand-in',
    why: 'The real ones belong to the instance you are borrowing, so this section is filled with an example account instead.',
  },
  {
    key: 'firewall',
    area: 'Firewalls',
    level: 'stand-in',
    why: 'One rule on a shared machine is a rule for everybody on it, so these are example rules on example machines.',
  },
  {
    key: 'dns-zones',
    area: 'DNS zones and custom domains',
    level: 'stand-in',
    why: 'The zone belongs to the instance, not to a tenancy. This is an example one — your applications still get a real name with a real certificate.',
  },
  {
    key: 'backups',
    area: 'Backups, snapshots and restores',
    level: 'stand-in',
    why: 'Everything here is deleted in 24 hours by design, so there is nothing to protect. These are example schedules and runs.',
  },
  {
    key: 'access',
    area: 'Access — users, roles and grants',
    level: 'stand-in',
    why: 'The real list here is the other guests and the operator, which is nobody\u2019s business but theirs. This is an example organisation, so you can see how access is actually handed out.',
  },
  {
    key: 'keys',
    area: 'SSH keys',
    level: 'closed',
    why: 'A key into a machine you share is a key into everybody\u2019s. None is shown here, not even an invented one.',
  },
  {
    // The one credential a guest may mint, and the reason the trial has an
    // agent at all. It is worth no more than the guest: every scope it can
    // carry is checked against the permissions the guest itself holds, and
    // every call the agent makes is fenced exactly as the guest's own are.
    key: 'agent-keys',
    area: 'Connecting a coding agent',
    level: 'full',
    // The address is in the copy on purpose: it is the one thing a guest has to
    // type into their own editor, and until the key screen exists there is
    // nowhere else it is written down. The stdio bridge is for clients that
    // cannot speak streamable HTTP; it reads the same key out of FLUI_MCP_KEY.
    why: 'Hand an agent a key of your own and let it deploy and operate your applications, with the same limits you have here. Point it at POST /api/v1/mcp on this instance with an `Authorization: Bearer <your key>` header, and switch it off again by revoking the key.',
  },
  {
    key: 'platform-config',
    area: 'Cluster-wide variables and secrets',
    level: 'closed',
    why: "Those belong to the platform, not to a tenancy. Your application's own variables are yours to edit.",
  },
  {
    // Two different things under one word, and the copy used to name only the
    // second. Per-application routes and their policies are reached through
    // `/applications/:id/gateway/**`, which the fence opens: a guest adds a
    // route on its own application and rate-limits it, and that was true while
    // this line said `closed`. What is shut is the cluster-wide view — every
    // route on the machine, whoever owns it.
    key: 'gateway',
    area: 'Gateway routes and policies',
    level: 'full',
    why: 'The routes of your own applications are yours to add, protect and remove \u2014 under the subdomain this sandbox serves you from, and never on a name somebody else is already answering for. The cluster-wide list of everybody\u2019s routes is not shown.',
  },
  {
    key: 'migrations',
    area: 'Migrations between clusters',
    level: 'read-only',
    why: 'Moving a workload to another cluster needs a second cluster of your own, which a trial does not have. What is recorded here is shown as it is.',
  },
  {
    key: 'mail',
    area: 'Mail',
    level: 'stand-in',
    why: 'The real one shows recipients \u2014 other people\u2019s addresses. This is an example account with its own traffic, domain proofs and bounces.',
  },
  {
    key: 'models',
    area: 'Inference providers and models',
    level: 'stand-in',
    why: 'Which models the platform talks to, on an example account. No key value is ever shown.',
  },
  {
    key: 'assistant',
    area: 'The assistant',
    level: 'read-only',
    why: 'You can see what it is and what it knows. Asking it something costs inference the instance pays for, so that stays off here.',
  },
  {
    // Read by a person on the screen and by their agent through the MCP tool,
    // which is why the wording says "and your agent" out loud: the same notes
    // travel to both, and a visitor who did not know that would be surprised
    // by an agent quoting the house rules back at them.
    key: 'operating-context',
    area: 'How this installation is run',
    level: 'read-only',
    why: 'The notes the operators wrote about how things are done here — the platform’s and this cluster’s. You and your agent can read them; writing one belongs to whoever runs the instance.',
  },
  {
    key: 'credentials',
    area: 'Credentials, kubeconfig and secret values',
    level: 'closed',
    why: 'No value is ever shown here, not even an invented one.',
  },
];
