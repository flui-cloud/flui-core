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
    key: 'catalog',
    area: 'The app catalogue',
    level: 'full',
    why: 'Install anything from it into your own space.',
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
    area: 'SSH keys and API keys',
    level: 'closed',
    why: 'A key is a way in. None is shown here, not even an invented one.',
  },
  {
    key: 'platform-config',
    area: 'Cluster-wide variables and secrets',
    level: 'closed',
    why: "Those belong to the platform, not to a tenancy. Your application's own variables are yours to edit.",
  },
  {
    key: 'gateway',
    area: 'Gateway policies',
    level: 'closed',
    why: 'They act on shared infrastructure, so one guest\u2019s rule would be everybody\u2019s.',
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
    key: 'credentials',
    area: 'Credentials, kubeconfig and secret values',
    level: 'closed',
    why: 'No value is ever shown here, not even an invented one.',
  },
];
