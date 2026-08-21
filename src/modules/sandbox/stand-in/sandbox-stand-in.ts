import { HttpVerb, routeMatches } from '../constants/sandbox-fence';
import { SandboxStandInQuery } from './sandbox-world-core';

export { SandboxStandInQuery } from './sandbox-world-core';
import {
  exampleBackupDestinations,
  exampleBackupJobs,
  exampleBackupPolicies,
  exampleBackupStatus,
  exampleRestoreJobs,
} from './sandbox-world-backups';
import {
  exampleIamGrants,
  exampleIamGroups,
  exampleIamPrincipals,
  exampleIamResources,
  exampleIamRoles,
  exampleUsers,
} from './sandbox-world-people';
import {
  exampleMailConnections,
  exampleMailConnectionSetup,
  exampleMailDomains,
  exampleMailEvents,
  exampleMailOverview,
  exampleMailReadiness,
  exampleMailSuppressions,
} from './sandbox-world-mail';
import {
  exampleCredentialsStatus,
  exampleInferenceConnections,
  exampleInferenceProviders,
} from './sandbox-world-models';
import {
  exampleDnsZones,
  exampleFirewalls,
  exampleInstances,
  exampleProviderConfigurations,
  exampleProviderRegions,
  exampleProviders,
  exampleVNets,
} from './sandbox-world';

/**
 * Which routes answer from the example world instead of from the instance.
 *
 * A stand-in is served *instead of* running the handler, never alongside it: the
 * real one would reach a real provider, and the whole reason these sections are
 * fenced off is that the provider is not the guest's.
 */
/**
 * `query` is the request's own query string. Most builders ignore it; the ones
 * that answer a window or a filter must not, or the section shows a person one
 * thing while their own control says another — which is the same failure as a
 * date pinned to a fixed day, just harder to spot.
 */
export type SandboxStandInParams = Record<string, string | undefined>;

export interface SandboxStandInRule {
  verbs: HttpVerb[];
  pattern: string;
  build: (
    now: number,
    query?: SandboxStandInQuery,
    params?: SandboxStandInParams,
  ) => unknown;
}

/**
 * One element of an example list, picked by the id in the path.
 *
 * Every list in this file backs a screen whose rows are clickable, and a row
 * that opens onto a refusal is the same defect as a menu entry that does: the
 * person clicking it learns that the product is broken, not that the demo is
 * limited. So each list that has a detail route gets one of these, built from
 * the very same list — there is no second copy of the world to fall out of step.
 */
const byId =
  (list: (now: number) => unknown, param = 'id'): SandboxStandInRule['build'] =>
  (now, _query, params) => {
    const wanted = params?.[param];
    const rows = list(now);
    if (!Array.isArray(rows)) return null;
    return (
      (rows as Array<{ id?: string }>).find((row) => row.id === wanted) ?? null
    );
  };

export const SANDBOX_STAND_INS: SandboxStandInRule[] = [
  { verbs: ['GET'], pattern: '/management/providers', build: exampleProviders },
  {
    verbs: ['GET'],
    pattern: '/management/configurations',
    build: exampleProviderConfigurations,
  },
  { verbs: ['GET'], pattern: '/instances', build: exampleInstances },
  { verbs: ['GET'], pattern: '/vnets', build: exampleVNets },
  { verbs: ['GET'], pattern: '/firewalls', build: exampleFirewalls },
  { verbs: ['GET'], pattern: '/dns/zones', build: exampleDnsZones },
  {
    verbs: ['GET'],
    pattern: '/backup-destinations',
    build: exampleBackupDestinations,
  },
  { verbs: ['GET'], pattern: '/backup-policies', build: exampleBackupPolicies },
  { verbs: ['GET'], pattern: '/restore-jobs', build: exampleRestoreJobs },
  { verbs: ['GET'], pattern: '/backups/status', build: exampleBackupStatus },
  {
    verbs: ['GET'],
    pattern: '/backup-jobs/cluster/:clusterId',
    build: exampleBackupJobs,
  },

  // Access. The real answer here is the list of the other guests and of the
  // operator, so this one is never a projection — see sandbox-world-people.ts.
  { verbs: ['GET'], pattern: '/auth/users', build: exampleUsers },
  { verbs: ['GET'], pattern: '/iam/roles', build: exampleIamRoles },
  { verbs: ['GET'], pattern: '/iam/grants', build: exampleIamGrants },
  { verbs: ['GET'], pattern: '/iam/groups', build: exampleIamGroups },
  { verbs: ['GET'], pattern: '/iam/resources', build: exampleIamResources },
  { verbs: ['GET'], pattern: '/iam/principals', build: exampleIamPrincipals },

  // Mail. The real answer is recipient addresses — other people's data.
  { verbs: ['GET'], pattern: '/mail/overview', build: exampleMailOverview },
  {
    verbs: ['GET'],
    pattern: '/mail/connections',
    build: exampleMailConnections,
  },
  { verbs: ['GET'], pattern: '/mail/events', build: exampleMailEvents },
  { verbs: ['GET'], pattern: '/mail/domains', build: exampleMailDomains },
  { verbs: ['GET'], pattern: '/mail/readiness', build: exampleMailReadiness },
  {
    verbs: ['GET'],
    pattern: '/mail/suppressions',
    build: exampleMailSuppressions,
  },

  // The models Settings talks to. Declared, never valued.
  {
    verbs: ['GET'],
    pattern: '/inference/providers',
    build: exampleInferenceProviders,
  },
  {
    verbs: ['GET'],
    pattern: '/inference/connections',
    build: exampleInferenceConnections,
  },
  {
    verbs: ['GET'],
    pattern: '/credentials/status',
    build: exampleCredentialsStatus,
  },

  // The detail behind a row. Same lists, one element each.
  {
    verbs: ['GET'],
    pattern: '/backup-policies/:id',
    build: byId(exampleBackupPolicies),
  },
  {
    verbs: ['GET'],
    pattern: '/backup-destinations/:id',
    build: byId(exampleBackupDestinations),
  },
  {
    verbs: ['GET'],
    pattern: '/restore-jobs/:id',
    build: byId(exampleRestoreJobs),
  },
  {
    verbs: ['GET'],
    pattern: '/backup-jobs/:id',
    build: byId(exampleBackupJobs),
  },
  {
    verbs: ['GET'],
    // The list route answers `{ vnets, total }`; the detail wants the element.
    pattern: '/vnets/:id',
    build: byId((now) => exampleVNets(now).vnets),
  },
  { verbs: ['GET'], pattern: '/firewalls/:id', build: byId(exampleFirewalls) },
  { verbs: ['GET'], pattern: '/dns/zones/:id', build: byId(exampleDnsZones) },
  {
    verbs: ['GET'],
    pattern: '/management/providers/:provider',
    build: byId(exampleProviders, 'provider'),
  },
  { verbs: ['GET'], pattern: '/auth/users/:id', build: byId(exampleUsers) },
  {
    verbs: ['GET'],
    pattern: '/management/providers/:provider/regions',
    build: exampleProviderRegions,
  },
  {
    verbs: ['GET'],
    pattern: '/mail/connections/:id/setup',
    build: exampleMailConnectionSetup,
  },
];

export function findSandboxStandIn(
  verb: string,
  path: string,
): SandboxStandInRule | undefined {
  return SANDBOX_STAND_INS.find(
    (rule) =>
      rule.verbs.includes(verb.toUpperCase() as HttpVerb) &&
      routeMatches(rule.pattern, path),
  );
}

/**
 * Whether a path belongs to a stand-in area at all, regardless of verb.
 *
 * Used to answer a write with a plain refusal rather than a fence message: the
 * area is shown, so "this is disabled here" would be confusing. The better
 * version accepts the gesture and shows it for the session, but a person who
 * does not realise it was pretend finds out afterwards they changed nothing,
 * which is worse than being told up front.
 */
export function isStandInArea(path: string): boolean {
  return SANDBOX_STAND_INS.some(
    (rule) =>
      routeMatches(rule.pattern, path) ||
      // Anything under a stand-in list belongs to the same section: creating a
      // policy, running one, editing a zone's records. They all deserve the same
      // wording, not the generic "this is disabled here".
      routeMatches(`${rule.pattern}/**`, path),
  );
}

export const SANDBOX_STAND_IN_WRITE_CODE = 'SANDBOX_STAND_IN';

export const SANDBOX_STAND_IN_WRITE_MESSAGE =
  'This section is showing example data, so there is nothing here to change. Your own applications, databases and their settings are real and yours to edit.';

/**
 * Whether this request will be answered from the example world.
 *
 * The guards downstream of the fence protect a handler that, for these requests,
 * never runs — the projection interceptor answers first. Making them refuse
 * would close a section the fence has deliberately opened, so they step aside
 * for exactly these paths and for a guest only.
 */
export function isSandboxStandInRequest(req: {
  method?: string;
  route?: { path?: string };
  path?: string;
}): boolean {
  const raw = req.route?.path ?? req.path ?? '';
  const path = raw.replace(/^\/api\/v\d+/, '');
  return Boolean(req.method && findSandboxStandIn(req.method, path));
}
