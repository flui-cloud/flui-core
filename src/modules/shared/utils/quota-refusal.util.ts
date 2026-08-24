/**
 * Reading a Kubernetes admission refusal as a sentence a person can act on.
 *
 * The limit itself is not ours and must not be: every sandbox tenancy gets a
 * `ResourceQuota` and a `LimitRange` (`sandbox-quota.manifest.ts`), and a second
 * check written in Flui would be a second truth that drifts from the first. What
 * was missing was never the limit — it was the wording. Kubernetes already says
 * *what* was asked for, *how much is in use* and *what the ceiling is*; it just
 * says it in a sentence about API objects.
 *
 * So this file translates and never decides. It is a pure function on the error
 * text, which means it works for the refusal that comes back from an API call
 * and for the one that only ever appears on a workload's status — the two ways a
 * quota refusal reaches a person, and the reason this is a function rather than
 * a branch inside one caller.
 */

/** Recognised in the quota's name, so a guest's ceiling reads as their trial. */
export const SANDBOX_QUOTA_NAME = 'sandbox-quota';
export const SANDBOX_LIMIT_RANGE_NAME = 'sandbox-limits';

/**
 * `SANDBOX_`-prefixed on purpose: the dashboard's `isSandboxRefusal()` reads that
 * prefix to tell a refusal from a fault, and a quota ceiling is the most literal
 * refusal in the product — the answer is no, and nothing is broken.
 */
export const QUOTA_EXCEEDED_CODE = 'SANDBOX_QUOTA_EXCEEDED';

export interface QuotaRefusal {
  code: string;
  /** A sentence for a person: what they have used, and of how much. */
  message: string;
  /** The `metadata.name` of the ResourceQuota or LimitRange that refused. */
  limitName: string;
  /** Whether the refusing limit is the one a sandbox tenancy is given. */
  sandbox: boolean;
}

/**
 * How each quota key is said out loud. Anything absent falls back to the key
 * itself, which is still truthful — a new quota key must not make this throw or
 * invent a noun for something it has never seen.
 */
const RESOURCE_NOUN: Record<string, string> = {
  pods: 'pods',
  services: 'services',
  'services.nodeports': 'node ports',
  'services.loadbalancers': 'load balancers',
  persistentvolumeclaims: 'volumes',
  'requests.cpu': 'CPU (requested)',
  'limits.cpu': 'CPU (limit)',
  'requests.memory': 'memory (requested)',
  'limits.memory': 'memory (limit)',
  'requests.storage': 'storage',
  count: 'objects',
};

function noun(resource: string): string {
  return RESOURCE_NOUN[resource] ?? resource;
}

/** `pods=1,requests.cpu=500m` → `[['pods','1'], ['requests.cpu','500m']]` */
function parsePairs(list: string): Array<[string, string]> {
  return list
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      return eq < 0
        ? ([part, ''] as [string, string])
        : ([part.slice(0, eq).trim(), part.slice(eq + 1).trim()] as [
            string,
            string,
          ]);
    });
}

/**
 * The text of a refusal, wherever it is carried.
 *
 * The Kubernetes client stringifies status bodies into `error.message`, so the
 * message is usually enough; `body` is read too because a workload condition
 * hands the same sentence over as a plain object.
 */
function textOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return '';
  const e = error as { message?: unknown; body?: unknown };
  const parts: string[] = [];
  if (typeof e.message === 'string') parts.push(e.message);
  if (typeof e.body === 'string') parts.push(e.body);
  else if (e.body && typeof e.body === 'object') {
    try {
      parts.push(JSON.stringify(e.body));
    } catch {
      // A body that will not stringify tells us nothing; the message stands.
    }
  }
  return parts.join('\n');
}

/**
 * `exceeded quota: sandbox-quota, requested: pods=1, used: pods=12, limited: pods=12`
 *
 * Kubernetes escapes nothing here and the shape has been stable for many
 * releases, so it is matched literally rather than guessed at. `used` and
 * `limited` are what a person wants; `requested` is only used to pick which
 * resource to name when several are listed at once.
 */
const QUOTA_HEAD_RE = /exceeded quota:\s*([^,\s][^,]*),\s*requested:\s*/;
const USED_MARK = ', used:';
const LIMITED_MARK = ', limited:';

/** Where a quoted shell wrapper ends the sentence, if it does. */
function untilQuote(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === '\\' || c === '\n') return text.slice(0, i);
  }
  return text;
}

/** `maximum cpu usage per Container is 1, but limit is 2` */
const LIMIT_RANGE_RE =
  /(maximum|minimum)\s+(\S+)\s+usage per (\w+) is ([^,]+), but (?:limit|request) is (\S+)/i;

function describeResourceQuota(text: string): QuotaRefusal | null {
  const head = QUOTA_HEAD_RE.exec(text);
  if (!head) return null;

  // The three lists are cut on their literal markers rather than on one regex
  // that has to know a value may itself contain commas.
  const rest = text.slice(head.index + head[0].length);
  const usedAt = rest.indexOf(USED_MARK);
  if (usedAt < 0) return null;
  const afterUsed = rest.slice(usedAt + USED_MARK.length);
  const limitedAt = afterUsed.indexOf(LIMITED_MARK);
  if (limitedAt < 0) return null;

  const limitName = head[1].trim();
  const requested = parsePairs(rest.slice(0, usedAt));
  const used = new Map(parsePairs(afterUsed.slice(0, limitedAt)));
  const limited = new Map(
    parsePairs(untilQuote(afterUsed.slice(limitedAt + LIMITED_MARK.length))),
  );

  // Several resources can be listed at once. Name the ones actually at their
  // ceiling; if none reads that way, name everything that was asked for, so the
  // sentence never becomes "you are over a limit" with no limit in it.
  const atCeiling = requested
    .map(([key]) => key)
    .filter((key) => used.has(key) && limited.has(key));
  const keys = atCeiling.length > 0 ? atCeiling : [...limited.keys()];
  if (keys.length === 0) return null;

  const clauses = keys.map(
    (key) =>
      `${used.get(key) ?? '?'} of the ${limited.get(key) ?? '?'} ${noun(key)}`,
  );
  const sandbox = limitName === SANDBOX_QUOTA_NAME;
  const where = sandbox ? 'your trial allows' : 'this namespace allows';

  return {
    code: QUOTA_EXCEEDED_CODE,
    message: `You have used ${clauses.join(' and ')} ${where}. Remove something you no longer need, or ask for less.`,
    limitName,
    sandbox,
  };
}

function describeLimitRange(text: string): QuotaRefusal | null {
  const match = LIMIT_RANGE_RE.exec(text);
  if (!match) return null;

  const [, bound, resource, scope, ceiling, asked] = match;
  const direction = bound.toLowerCase() === 'maximum' ? 'at most' : 'at least';
  return {
    code: QUOTA_EXCEEDED_CODE,
    // The LimitRange never names itself in the message, so the name is the one
    // this product applies. Saying "sandbox-limits" is a claim, not a reading.
    limitName: '',
    sandbox: false,
    message: `Each ${scope.toLowerCase()} may use ${direction} ${ceiling} ${resource}, and this one asks for ${asked}. Lower it and try again.`,
  };
}

/**
 * Read a Kubernetes admission refusal, or return null for anything else.
 *
 * Null is the important half: this must never turn a genuine fault into a
 * reassuring sentence about limits.
 */
export function describeQuotaRefusal(error: unknown): QuotaRefusal | null {
  const text = textOf(error);
  if (!text) return null;
  return describeResourceQuota(text) ?? describeLimitRange(text);
}

export function isQuotaRefusal(error: unknown): boolean {
  return describeQuotaRefusal(error) !== null;
}
