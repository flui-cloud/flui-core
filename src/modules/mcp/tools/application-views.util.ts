/**
 * What the application tools show a model, and how they read what it typed.
 *
 * Kept beside the tool definitions rather than inside them: every one of these
 * is a decision about how a weak model reads an answer — an absent URL, a pod
 * that never started, an enum spelled the way a person would say it — and those
 * decisions are worth reading on their own, without a hundred lines of schema
 * around them.
 */

/** Path-segment safety: an id from a model is input, not a literal. */
export const enc = encodeURIComponent;

// Explicit sentinel so a weak model reads "no endpoint" rather than guessing one
// exists (or deflecting to the CLI) when the url/internalUrl fields are simply absent.
const NO_ENDPOINT = 'none — app has no endpoint configured';

/**
 * What to tell the model in place of a URL. "No endpoint" and "the endpoint
 * failed to come up" look identical from the outside but need opposite advice:
 * the first is a design choice, the second is a broken app with a fixable cause.
 * Collapsed into one string, a failed install reads as a healthy one.
 */
export function urlForModel(app: {
  url?: string;
  internalUrl?: string;
  endpointStatus?: string;
  endpointError?: string;
}): string {
  if (app.url) return app.url;
  if (app.internalUrl) return app.internalUrl;
  if (app.endpointStatus === 'ERROR') {
    return `unreachable — its public endpoint failed to provision, so there is no DNS record or ingress: ${
      app.endpointError ?? 'no reason recorded'
    }`;
  }
  if (app.endpointStatus && app.endpointStatus !== 'IN_SYNC') {
    return `not ready yet — the public endpoint is still being provisioned (${app.endpointStatus}); re-check before giving the user a link`;
  }
  return NO_ENDPOINT;
}

/** Operations carry config sub-objects; the model only needs the handle + status. */
export function operationView(data: unknown): unknown {
  const op = data as { id?: string; operationType?: string; status?: string };
  return { operationId: op.id, type: op.operationType, status: op.status };
}

/**
 * Validate a model-supplied enum filter case-insensitively. Returns undefined when
 * the value is absent. On a value that is not part of the enum, throws a message that
 * names the allowed values — so the model self-corrects instead of hitting a cryptic
 * Postgres enum error (e.g. the model passing category="database" when DATABASE is a kind).
 */
export function matchEnum<T extends Record<string, string>>(
  field: string,
  value: string | undefined,
  enumObj: T,
  casing: 'upper' | 'lower',
): T[keyof T] | undefined {
  if (value === undefined) return undefined;
  const wanted = casing === 'upper' ? value.toUpperCase() : value.toLowerCase();
  const allowed = Object.values(enumObj);
  const hit = allowed.find((v) => v === wanted);
  if (!hit) {
    throw new Error(
      `Invalid ${field} "${value}". Allowed ${field} values: ${allowed.join(', ')}.`,
    );
  }
  return hit as T[keyof T];
}

/** Container state → a one-line problem string (or none when it is healthy). */
function containerProblem(state?: {
  waiting?: { reason?: string; message?: string };
  terminated?: { reason?: string; exitCode?: number; message?: string };
}): string | undefined {
  const w = state?.waiting;
  if (w?.reason) return w.message ? `${w.reason}: ${w.message}` : w.reason;
  const t = state?.terminated;
  if (t?.reason) {
    const base = `${t.reason} (exit ${t.exitCode})`;
    return t.message ? `${base}: ${t.message}` : base;
  }
  return undefined;
}

/**
 * Pod-debug dumps are huge (env, annotations, probes, affinity); the model only
 * needs the failure signal: phase, each container's readiness/restarts/problem,
 * missing mounts, and the most recent events.
 */
export function podDebugView(data: unknown): unknown {
  const pods = data as Array<{
    name?: string;
    phase?: string;
    containers?: Array<{
      name?: string;
      ready?: boolean;
      restartCount?: number;
      state?: Parameters<typeof containerProblem>[0];
    }>;
    volumes?: Array<{ name?: string; exists?: boolean }>;
    events?: Array<{
      type?: string;
      reason?: string;
      message?: string;
      count?: number;
    }>;
  }>;
  return pods.map((p) => ({
    pod: p.name,
    phase: p.phase,
    containers: (p.containers ?? []).map((c) => ({
      name: c.name,
      ready: c.ready,
      restarts: c.restartCount,
      problem: containerProblem(c.state),
    })),
    missingMounts: (p.volumes ?? [])
      .filter((v) => v.exists === false)
      .map((v) => v.name),
    events: (p.events ?? []).slice(0, 6).map((e) => ({
      type: e.type,
      reason: e.reason,
      message: e.message,
      count: e.count,
    })),
  }));
}

/**
 * `POST :id/stop` and `POST :id/start` answer with the application, whose
 * `replicas` is the desired count and whose `status` says whether it is meant
 * to be running. There is no ready/available in that body, and inventing one
 * would tell the model the pods are up when nothing has looked.
 */
export function replicaStateView(data: unknown): unknown {
  const a = data as { slug?: string; status?: string; replicas?: number };
  return { app: a.slug, status: a.status, desired: a.replicas };
}

/** Runtime responses carry pods/containers; the model only needs the replica summary. */
export function runtimeView(data: unknown): unknown {
  const r = data as {
    deploymentName?: string;
    replicas?: { desired?: number; ready?: number; available?: number };
  };
  return {
    app: r.deploymentName,
    desired: r.replicas?.desired,
    ready: r.replicas?.ready,
    available: r.replicas?.available,
  };
}
