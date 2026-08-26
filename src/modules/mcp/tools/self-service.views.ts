import { z } from 'zod';
import { McpApiError } from '../services/mcp-api.client';
import { enc } from './application-views.util';
import { McpToolContext } from './mcp-tool.util';

/**
 * How the self-service tools say what came back.
 *
 * Every renderer here answers to a tool in `self-service.tools.ts` and to
 * nothing else. They are apart from the registry because what a payload is
 * turned into is a different question from which route a tool is allowed to
 * call, and mixing the two is what made the file unreadable at length.
 */

/** Revisions come back newest first; `status` is the application's at the time. */
export interface Revision {
  revisionNumber?: number;
  imageRef?: string;
  commitSha?: string;
  status?: string;
  eventType?: string;
  createdAt?: string;
  buildId?: string | null;
}

export function revisionLine(r: Revision): string {
  const bits = [
    `#${r.revisionNumber}`,
    r.imageRef ?? r.commitSha ?? 'no image recorded',
    r.status,
    r.createdAt,
  ].filter(Boolean);
  return bits.join(' · ');
}

/**
 * The revision a plain "put it back" means.
 *
 * The highest revision below the current one that did not fail. Failed
 * revisions are skipped because rolling back onto one is the one outcome a
 * person never asks for by saying "undo": it would replace a broken deployment
 * with a differently broken one and report success.
 *
 * Deliberately not a guess about *which* revision was healthy — the platform
 * records a status per revision and this reads it. When nothing qualifies the
 * caller is told what the list held, rather than being given a number that
 * happened to be there.
 */
export function previousGoodRevision(
  revisions: Revision[],
): Revision | undefined {
  const numbered = revisions
    .filter((r) => typeof r.revisionNumber === 'number')
    .sort((a, b) => (b.revisionNumber ?? 0) - (a.revisionNumber ?? 0));
  const current = numbered[0]?.revisionNumber;
  if (current === undefined) return undefined;
  return numbered.find(
    (r) => (r.revisionNumber ?? 0) < current && r.status !== 'failed',
  );
}

/**
 * Kubernetes quantities, checked before the call rather than after it.
 *
 * A model writes "512MB" and "0.5 CPU" as readily as "512Mi" and "500m", and
 * the cluster's refusal for those arrives as a 422 from three layers down with
 * no hint of the right spelling. One sentence naming the accepted forms costs a
 * turn; the other costs the turn plus the guess that follows it.
 */
const DECIMAL = /^\d+$|^\d+\.\d+$/;
const MILLICORES = /^\d+m$/;
const MEMORY_SUFFIX = /(Ki|Mi|Gi|Ti|Pi|k|M|G|T|P)$/;

const isCpuQuantity = (value: string): boolean =>
  MILLICORES.test(value) || DECIMAL.test(value);

// The suffix is taken off first and the rest checked as a plain number, rather
// than expressed as one pattern: the combined form reads as a backtracking risk
// to the linter, and two small patterns say the same thing without the argument.
const isMemoryQuantity = (value: string): boolean =>
  DECIMAL.test(value.replace(MEMORY_SUFFIX, ''));

export function assertQuantities(spec?: {
  cpu?: string;
  memory?: string;
}): void {
  if (spec?.cpu && !isCpuQuantity(spec.cpu)) {
    throw new Error(
      `Invalid cpu quantity "${spec.cpu}". Use cores ("1", "0.5") or millicores ("500m") — not "0.5 CPU" or "500 millicores".`,
    );
  }
  if (spec?.memory && !isMemoryQuantity(spec.memory)) {
    throw new Error(
      `Invalid memory quantity "${spec.memory}". Use a Kubernetes quantity ("256Mi", "1Gi", "512M") — not "512MB" or "1 GB".`,
    );
  }
}

export interface ResourceSpec {
  cpu?: string;
  memory?: string;
}

export const resourceSpec = z.object({
  cpu: z.string().optional(),
  memory: z.string().optional(),
});

/** Container specs and live usage, as much as the model needs to decide again. */
export function containersView(data: unknown): unknown {
  const r = data as {
    deploymentName?: string;
    replicas?: { desired?: number; ready?: number };
    containers?: Array<{
      name?: string;
      requests?: ResourceSpec;
      limits?: ResourceSpec;
      usage?: ResourceSpec;
    }>;
  };
  return {
    app: r.deploymentName,
    desired: r.replicas?.desired,
    ready: r.replicas?.ready,
    containers: (r.containers ?? []).map((c) => ({
      name: c.name,
      requests: c.requests,
      limits: c.limits,
      usage: c.usage,
    })),
    note: 'The Deployment was patched, so the pods are being replaced. `usage` above is what the OLD pods were doing; re-read it with app_status once the new ones are ready.',
  };
}

/**
 * Drift found and nothing healed is the answer that reads as success and is not
 * one: an application declares its own drift policy, and unless it is
 * `auto_heal` this call only observes.
 */
function driftNote(drifted: string[], healed: string[]): string {
  if (!drifted.length) {
    return 'No drift: the cluster matches what Flui has recorded.';
  }
  return healed.length
    ? 'Drift was found and put back.'
    : 'Drift was found and NOT corrected — this application does not heal automatically. Tell the person what drifted; redeploying is what puts it back.';
}

export function reconcileView(data: unknown): unknown {
  const s = data as {
    applicationName?: string;
    previousStatus?: string;
    newStatus?: string;
    driftedResources?: string[];
    healedResources?: string[];
    errors?: string[];
  };
  const drifted = s.driftedResources ?? [];
  const healed = s.healedResources ?? [];
  return {
    app: s.applicationName,
    statusBefore: s.previousStatus,
    statusAfter: s.newStatus,
    drifted,
    healed,
    errors: s.errors ?? [],
    note: driftNote(drifted, healed),
  };
}

interface MetricSlice {
  usage_cores?: number | null;
  usage_bytes?: number | null;
  requests_cores?: number | null;
  requests_bytes?: number | null;
  limits_cores?: number | null;
  limits_bytes?: number | null;
  utilization_percent?: number | null;
}

interface MetricsPayload {
  app_name?: string;
  metrics?: {
    cpu?: MetricSlice;
    memory?: MetricSlice;
    network?: { receive_bytes_rate?: number | null };
    volume?: {
      used_bytes?: number | null;
      capacity_bytes?: number | null;
      utilization_percent?: number | null;
      alert_level?: string;
    } | null;
    status?: {
      replicas_desired?: number | null;
      replicas_ready?: number | null;
      replicas_unavailable?: number | null;
      up?: number | null;
    };
    pods?: Array<{ phase?: string; count?: number }>;
    health?: unknown;
  };
  queried_at?: string;
}

/**
 * An empty answer and a zero answer look the same in JSON, and only one of them
 * is true.
 *
 * When Prometheus is not reachable — or the recording rules have not been
 * installed on this cluster — every number below arrives as `null`. A model
 * handed `{"usage_cores": null}` reports an idle application. Saying it out
 * loud is the difference between "it is using no CPU" and "nobody is measuring".
 */
function nothingMeasured(m: MetricsPayload['metrics']): boolean {
  return (
    m?.cpu?.usage_cores == null &&
    m?.memory?.usage_bytes == null &&
    m?.status?.replicas_ready == null
  );
}

export function metricsView(data: unknown): unknown {
  const p = data as MetricsPayload;
  const m = p.metrics ?? {};
  if (nothingMeasured(m)) {
    return {
      app: p.app_name,
      measured: false,
      note: 'No metrics came back at all — not zero, UNMEASURED. Prometheus is not answering for this cluster, or the recording rules are not installed. Do NOT report this application as idle or healthy on the strength of this call; use app_status, which reads the cluster directly.',
    };
  }
  return {
    app: p.app_name,
    measured: true,
    cpu: {
      usingCores: m.cpu?.usage_cores,
      limitCores: m.cpu?.limits_cores,
      percentOfLimit: m.cpu?.utilization_percent,
    },
    memory: {
      usingBytes: m.memory?.usage_bytes,
      limitBytes: m.memory?.limits_bytes,
      percentOfLimit: m.memory?.utilization_percent,
    },
    replicas: {
      desired: m.status?.replicas_desired,
      ready: m.status?.replicas_ready,
      unavailable: m.status?.replicas_unavailable,
    },
    pods: (m.pods ?? []).map((p2) => `${p2.phase}: ${p2.count}`),
    disk: m.volume
      ? {
          usedBytes: m.volume.used_bytes,
          capacityBytes: m.volume.capacity_bytes,
          percentFull: m.volume.utilization_percent,
          alert: m.volume.alert_level,
        }
      : 'no persistent volume',
    queriedAt: p.queried_at,
  };
}

export interface VariablesView {
  name?: string;
  data?: Record<string, string>;
  sensitiveKeys?: string[];
  pendingKeys?: string[];
}

const MASKED = '****';

/**
 * The variables, split the way the product splits them.
 *
 * `data` from the combined read carries the plain values AND the sensitive keys
 * masked as `****`. Handing that dictionary to a model whole would teach it
 * that a secret's value is the four-character string `****`, which is the kind
 * of confident nonsense that ends up in a generated config file. The three
 * lists below say which is which, and only one of them carries values.
 */
export function variablesView(raw: unknown): unknown {
  const v = raw as VariablesView;
  const sensitive = new Set(v.sensitiveKeys ?? []);
  const plain: Record<string, string> = {};
  for (const [key, value] of Object.entries(v.data ?? {})) {
    if (!sensitive.has(key) && value !== MASKED) plain[key] = value;
  }
  return {
    app: v.name,
    plain,
    sensitiveKeys: v.sensitiveKeys ?? [],
    awaitingAValue: v.pendingKeys ?? [],
    note: '`plain` carries real values. `sensitiveKeys` are configured and their values are NOT readable from here, by design — never guess or reconstruct one. `awaitingAValue` is declared-but-missing: ask a person for it with app_variable_request, never invent it.',
  };
}

/**
 * Names that mean the value behind them is a credential.
 *
 * A name test is a weak instrument and this is not the load-bearing one — the
 * strong check is the state the API already holds (a key the product knows as
 * sensitive is refused on the evidence, below). This is the second brake, for
 * the key that has never been declared at all: an agent writing `DB_PASSWORD`
 * as a *plain* variable puts a password in a ConfigMap, unencrypted, readable
 * by anything that can read the namespace, and the delivery path that exists to
 * prevent exactly that goes unused.
 *
 * The cost of a false positive is one sentence redirecting to a safer route.
 * The cost of a false negative is a password in clear, forever. The list is
 * therefore compound forms rather than bare words: `AUTH` would refuse
 * `NEXTAUTH_URL`, and a rule that refuses ordinary configuration teaches the
 * model to route around it.
 */
const CREDENTIAL_NAMES = [
  /PASSWORD|PASSWD|PASSPHRASE|SECRET|CREDENTIAL/i,
  /(API|ACCESS|PRIVATE|SIGNING|ENCRYPTION)_?KEY/i,
  // A whole word, not a substring: `TOKENISER` and `SUBTOKEN` pass, while
  // `GITHUB_TOKEN` and `TOKEN` do not.
  /(^|_)TOKEN($|_)/i,
];

const credentialName = (key: string): boolean =>
  CREDENTIAL_NAMES.some((pattern) => pattern.test(key));

/**
 * Values that ARE credentials, whatever they are called.
 *
 * The one check the name test cannot make, and the more certain of the two: a
 * value starting `sk_live_`, `ghp_`, `AKIA` or `-----BEGIN` is a secret no
 * matter what field it arrived in. Refusing it does not un-say it — by the time
 * this runs the model has already held it — which is why the refusal says to
 * ROTATE it rather than merely to move it.
 */
const CREDENTIAL_VALUE =
  /^(sk_live_|sk_test_|rk_live_|ghp_|gho_|ghs_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|-----BEGIN)/;

export function credentialShaped(
  key: string,
  value: string,
): string | undefined {
  if (CREDENTIAL_VALUE.test(value.trim())) {
    return `${key} — the VALUE has the shape of a credential (it starts with a known secret prefix). It has already passed through this conversation, so treat it as compromised: tell the person to rotate it, and deliver the new one with app_variable_request.`;
  }
  if (credentialName(key)) {
    return `${key} — the NAME says this is a credential, and a plain variable is written to a ConfigMap in clear text.`;
  }
  return undefined;
}

/** Where the app-scoped variables live. */
export const variablesPath = (appId: string): string =>
  `/variables/applications/${enc(appId)}`;

export interface SelfView {
  permissions?: string[];
  isAdmin?: boolean;
}

export interface SectionsView {
  sections?: string[];
  readOnlySections?: string[];
}

export interface TrialSession {
  expiresAt?: string;
  secondsRemaining?: number;
  ttlHours?: number;
}

export interface TrialLimits {
  areas?: Array<{ key?: string; area?: string; level?: string; why?: string }>;
  quota?: Record<string, unknown>;
}

/**
 * Whether a call came back "there is nothing of that kind here" rather than
 * failing. A non-sandbox instance answers 404 to the session route — and an
 * instance with the sandbox switched off entirely has no route to answer at
 * all, which arrives as the same 404.
 */
function isAbsence(error: unknown): boolean {
  return (
    error instanceof McpApiError &&
    (error.status === 404 || error.status === 403)
  );
}

export async function readOrAbsent<T>(
  ctx: McpToolContext,
  path: string,
): Promise<T | undefined> {
  try {
    return await ctx.api.get<T>(path);
  } catch (error) {
    if (isAbsence(error)) return undefined;
    throw error;
  }
}

const LEVEL_MEANING: Record<string, string> = {
  full: 'yours, with no difference from a paid instance',
  'read-only': 'you can look, you cannot change it here',
  'stand-in':
    'filled with an example that is NOT real — never report what you read there as this installation’s own',
  closed: 'not part of the trial',
};

export function trialView(
  session: TrialSession | undefined,
  limits: TrialLimits | undefined,
): unknown {
  if (!session) {
    return 'You are not in a trial. Nothing on this instance is limited by one, so a refusal you meet is a real permission or a real fault — never a trial boundary.';
  }
  return {
    endsAt: session.expiresAt,
    hoursLeft: session.secondsRemaining
      ? Math.round(session.secondsRemaining / 360) / 10
      : undefined,
    quota: limits?.quota,
    areas: (limits?.areas ?? []).map((a) => ({
      area: a.area,
      level: a.level,
      means: a.level ? LEVEL_MEANING[a.level] : undefined,
      why: a.why,
    })),
    // The whole reason this tool exists, said in the payload rather than only
    // in the description: a limit of the trial reported as a limit of the
    // product is the single most expensive sentence an agent can write here.
    note: 'These are limits of THIS TRIAL, not of Flui. When something here is `closed` or `stand-in`, say so in those words — "backups are not part of the trial", never "Flui cannot do backups". The difference is the whole of what the person is here to find out.',
  };
}
