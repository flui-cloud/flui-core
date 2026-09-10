/**
 * One implementation of "how an application reads a building block".
 *
 * It used to live inline in `CatalogLinkingService` and covered `host`, `port`,
 * `fromBBEnv` and `value`. `deploy.services[].env` in the flui.yaml spec asks
 * the same four questions plus a fifth — `url` — so the chain moved here and
 * both callers read it, instead of the two of them drifting apart on the day
 * one of them gains a branch.
 */

export interface LinkedEnvSpec {
  name: string;
  fromService?: 'host' | 'port' | 'url';
  fromBBEnv?: string;
  value?: string;
}

export interface ResolvedLinkedEnv {
  name: string;
  value: string;
  secret: boolean;
  externalSecretRef?: { secretName: string; key: string };
}

/**
 * What the resolver is allowed to know about the block. Everything here is
 * already committed — the block is RUNNING before this is called — so a
 * resolution is deterministic and never guesses.
 */
export interface BlockFacts {
  /** Catalog slug, used only in refusal messages. */
  ref: string;
  /** `<slug>-svc.<ns>.svc.cluster.local`. */
  host: string;
  /** First declared port. */
  port?: number | null;
  /** The block's own K8s Secret, `<slug>-secret`. */
  secretName: string;
  /** Env the BLOCK MANIFEST declares, with whether each is a secret. */
  declaredEnv: Array<{ name: string; secret: boolean }>;
  /** Plain (non-secret) values stored on the block's application row. */
  appEnv: Record<string, string>;
  /**
   * Key inside `secretName` holding the connection URL, or `null` when this
   * block has no URL form at all. Null is a refusal, never an empty string:
   * a container started with `DATABASE_URL=""` fails later and elsewhere.
   */
  connectionUrlKey: string | null;
}

/** A declaration the block cannot honour. Callers map it to a 400. */
export class LinkedEnvError extends Error {}

export function resolveLinkedEnvEntries(
  entries: LinkedEnvSpec[],
  facts: BlockFacts,
): ResolvedLinkedEnv[] {
  return entries.map((entry) => resolveLinkedEnvEntry(entry, facts));
}

function resolveLinkedEnvEntry(
  entry: LinkedEnvSpec,
  facts: BlockFacts,
): ResolvedLinkedEnv {
  if (entry.fromService === 'host') {
    return { name: entry.name, value: facts.host, secret: false };
  }
  if (entry.fromService === 'port') {
    return {
      name: entry.name,
      value: String(facts.port ?? ''),
      secret: false,
    };
  }
  if (entry.fromService === 'url') {
    return resolveFromUrl(entry, facts);
  }
  if (entry.value !== undefined) {
    return { name: entry.name, value: entry.value, secret: false };
  }
  if (entry.fromBBEnv) {
    return resolveFromBBEnv(entry, entry.fromBBEnv, facts);
  }
  throw new LinkedEnvError(
    `env "${entry.name}" has no fromService, fromBBEnv, or value`,
  );
}

function resolveFromUrl(
  entry: LinkedEnvSpec,
  facts: BlockFacts,
): ResolvedLinkedEnv {
  if (!facts.connectionUrlKey) {
    throw new LinkedEnvError(
      `env "${entry.name}": fromService: url is not available for block "${facts.ref}" — ` +
        `it declares no database engine, so it has no connection URL. Compose the ` +
        `address from fromService: host / port, or read a specific variable with fromBBEnv.`,
    );
  }
  return {
    name: entry.name,
    value: '',
    secret: true,
    externalSecretRef: {
      secretName: facts.secretName,
      key: facts.connectionUrlKey,
    },
  };
}

function resolveFromBBEnv(
  entry: LinkedEnvSpec,
  fromBBEnv: string,
  facts: BlockFacts,
): ResolvedLinkedEnv {
  const declared = facts.declaredEnv.find((e) => e.name === fromBBEnv);
  if (!declared) {
    throw new LinkedEnvError(
      `env "${entry.name}": fromBBEnv references ${fromBBEnv} but block ` +
        `"${facts.ref}" declares no such variable`,
    );
  }
  if (declared.secret) {
    return {
      name: entry.name,
      value: '',
      secret: true,
      externalSecretRef: { secretName: facts.secretName, key: fromBBEnv },
    };
  }
  return {
    name: entry.name,
    value: facts.appEnv[fromBBEnv] ?? '',
    secret: false,
  };
}
