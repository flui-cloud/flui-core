import { NotFoundException } from '@nestjs/common';

/**
 * The two things under the product that a portal console must never open.
 *
 * They are a category apart from the rest of the system apps. Grafana, Loki,
 * VictoriaMetrics and the API cache are ordinary risk: losing one loses
 * telemetry. These two are the product itself.
 *
 *  - the platform Postgres in `flui-system` holds every user, API key,
 *    encrypted provider token and application row on the installation;
 *  - the identity provider has no database of its own — the bootstrap points
 *    it at `postgres.flui-system.svc.cluster.local` — so the same port that
 *    opens the product also opens every session and credential on it.
 *
 * Today they look shut and are not: the bootstrap declares no
 * `flui.cloud/db-engine`, so the console answers "unrecognized engine" and the
 * caller reads a refusal where there is only an omission. The day somebody
 * declares the engine on that Postgres — a normal request, "I want a console on
 * my own system database" — the foundations open and nothing says so.
 *
 * So the exclusion is declared here, in one place, with the reason next to it,
 * and it deliberately hangs on nothing that could go missing: not on a label,
 * not on the engine declaration, not on recorded provenance. Taking a
 * foundation out of the fence means deleting a line and its reason on purpose;
 * no label added elsewhere can do it.
 */
export interface PlatformFoundation {
  /** Stable key for tests and server logs. Never shown to a caller. */
  key: string;
  /** Why this one is a foundation. Deleting the entry deletes this sentence. */
  why: string;
  /** Names it answers to on the cluster: slug, `app` label, workload name. */
  names: string[];
  /** Namespaces the bootstrap places it in. No tenancy ever owns these. */
  namespaces: string[];
  /** Ports that reach it inside those namespaces. */
  ports: number[];
}

/** The namespace the bootstrap puts the product's own workloads in. No tenancy ever lands here. */
const PLATFORM_NAMESPACE = 'flui-system';

export const PLATFORM_FOUNDATIONS: readonly PlatformFoundation[] = [
  {
    key: 'platform-postgres',
    why: "Flui's own database. Every user, API key, encrypted provider token and application row on this installation lives in it, and the identity provider keeps its tables there too. A SQL prompt on it is a SQL prompt on the product.",
    names: ['postgres', 'postgresql'],
    namespaces: [PLATFORM_NAMESPACE],
    ports: [5432],
  },
  {
    key: 'identity-provider',
    why: 'The identity provider. It carries no database of its own — the bootstrap manifest points it at the platform Postgres — so reaching it reaches every session, credential and grant on the instance.',
    names: ['zitadel', 'zitadel-login'],
    namespaces: [PLATFORM_NAMESPACE],
    ports: [8080, 5432],
  },
];

/**
 * What a caller is told — by the fence *and* by every other console refusal that
 * is not "this belongs to somebody else", which is why it lives here rather than
 * next to any one of them.
 *
 * A refusal that names its reason teaches a stranger that this id runs something
 * worth reaching, and where. So does a refusal that differs from the one next to
 * it: for a while the fence said this while an absent row said
 * `Application <id> not found`, and the pair could be told apart by anyone
 * willing to read the body — which is exactly the probe the fence exists to
 * defeat. One string, no id echoed back.
 */
export const CONSOLE_TARGET_ABSENT = 'Application console not found';

/** The shape the fence reads. Anything with these fields can be tested against it. */
export interface FoundationCandidate {
  slug?: string | null;
  name?: string | null;
  k8sNamespace?: string | null;
  labels?: Record<string, string> | null;
}

function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/** Fields that can carry the thing's own cluster identity, wherever it sits. */
function identityNamesOf(app: FoundationCandidate): string[] {
  const labels = app.labels ?? {};
  return [
    app.slug,
    labels['app'],
    labels['app.kubernetes.io/name'],
    labels['app.kubernetes.io/instance'],
  ]
    .map(norm)
    .filter(Boolean);
}

/**
 * Fields that only describe it. Read solely inside a platform namespace, where
 * no tenancy ever lands, so a user application called "Postgres" is untouched.
 */
function localNamesOf(app: FoundationCandidate): string[] {
  return [...identityNamesOf(app), norm(app.name)].filter(Boolean);
}

function tokensOf(value: string): string[] {
  return value.split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Which foundation this row is, or null.
 *
 * Three hooks, any one of which is enough, because an application is identified
 * three different ways today and each of them can change:
 *
 *  1. **the name it answers to** — slug or `app` label — which survives being
 *     moved to another namespace;
 *  2. **where it sits plus what it is called** — a platform namespace and the
 *     name carried as a token by any field — which survives a rename;
 *  3. **the port it is reached on**, checked at the transport by
 *     {@link platformFoundationAtTarget} — which survives the row being
 *     replaced outright, new id and all.
 *
 * The id is deliberately not one of them: it is coined by Flui at discovery and
 * differs on every installation, so a list of ids would be a list that is empty
 * everywhere it matters.
 */
export function platformFoundationOf(
  app: FoundationCandidate | null | undefined,
): PlatformFoundation | null {
  if (!app) return null;
  const namespace = norm(app.k8sNamespace);

  for (const foundation of PLATFORM_FOUNDATIONS) {
    const names = new Set(foundation.names.map(norm));

    if (identityNamesOf(app).some((value) => names.has(value))) {
      return foundation;
    }

    if (
      foundation.namespaces.map(norm).includes(namespace) &&
      localNamesOf(app).some((value) =>
        tokensOf(value).some((token) => names.has(token)),
      )
    ) {
      return foundation;
    }
  }
  return null;
}

/**
 * Which foundation a tunnel would land on, read from the transport coordinates
 * alone. This is the hook that holds when the row loses every name it had.
 */
export function platformFoundationAtTarget(
  namespace: string | null | undefined,
  port: number | null | undefined,
): PlatformFoundation | null {
  const ns = norm(namespace);
  for (const foundation of PLATFORM_FOUNDATIONS) {
    if (
      foundation.namespaces.map(norm).includes(ns) &&
      port != null &&
      foundation.ports.includes(port)
    ) {
      return foundation;
    }
  }
  return null;
}

/** Refuses a foundation as absent. Called by every console connection resolver. */
export function assertNotPlatformFoundation(
  app: FoundationCandidate | null | undefined,
): void {
  if (platformFoundationOf(app)) {
    throw new NotFoundException(CONSOLE_TARGET_ABSENT);
  }
}

/**
 * How a foundation is reached by the one road that is deliberately open.
 *
 * The fence above says the portal never opens these two. It does not say
 * nobody may: the operator of an installation has to be able to put `psql` on
 * her own database, and today the only way is to SSH to the master and guess.
 * So the road exists, and it is a different road on purpose — the caller gets
 * these coordinates and nothing else, opens the tunnel herself over SSH and an
 * in-cluster port-forward, and reads the password straight out of the Secret
 * with the cluster access she already had. Flui opens no connection, runs no
 * SQL and hands out no password, so nothing here passes through
 * {@link platformFoundationAtTarget}: the console guard, the resolvers and the
 * transport go on refusing these two exactly as they did.
 *
 * The two lists are kept separate for the same reason they are kept in one
 * file. Deleting a line here closes the carve-out and changes nothing about the
 * refusal; adding a line here can never widen what a console may open, because
 * no console reads this list. The fence stays the thing that has to be edited
 * on purpose, with its reason next to it.
 *
 * Nothing here names a Secret or a key. The password's address stays with the
 * CLI, which is the only thing that can read it: `db-secret.ts` states the
 * invariant as "the password deliberately never travels through the HTTP API",
 * and the narrow reading of that is that its address does not either.
 *
 * The identity provider's admin role — `zitadel_admin`, which owns the database
 * and may create roles — is deliberately not offered. Reading and repairing
 * identity data is what the road exists for; owning the schema is not, and
 * anybody who needs that still has the master.
 */
export interface FoundationReach {
  /** The {@link PlatformFoundation} this reaches. */
  key: string;
  engine: 'postgres';
  /** Namespace of the pod, for the caller's own port-forward. */
  namespace: string;
  /**
   * The StatefulSet's own `spec.selector.matchLabels`, which Kubernetes
   * guarantees the pod carries. Not `flui-app-id=<id>`: that id is coined by
   * Flui at discovery and a bootstrap-created pod cannot carry it.
   */
  podLabelSelector: string;
  remotePort: number;
  database: string;
  user: string;
}

export const FOUNDATION_REACH: readonly FoundationReach[] = [
  {
    key: 'platform-postgres',
    engine: 'postgres',
    namespace: PLATFORM_NAMESPACE,
    podLabelSelector: 'app=postgres',
    remotePort: 5432,
    database: 'fluicloud',
    user: 'fluicloud',
  },
  {
    // Same pod, same port: the identity provider keeps its tables in the
    // platform Postgres, which is the whole reason it is a foundation.
    key: 'identity-provider',
    engine: 'postgres',
    namespace: PLATFORM_NAMESPACE,
    podLabelSelector: 'app=postgres',
    remotePort: 5432,
    database: 'zitadel',
    user: 'zitadel_user',
  },
];

/** The reach declared for a foundation key, or null — including for a key that names no foundation. */
export function foundationReachOf(
  key: string | null | undefined,
): FoundationReach | null {
  const wanted = norm(key);
  return FOUNDATION_REACH.find((reach) => norm(reach.key) === wanted) ?? null;
}
