/**
 * Secrets engine family. OpenBao today, spoken over the Vault-compatible HTTP
 * API (KV v2 secrets engine). Unlike a cache, the keyspace is enumerable
 * (LIST on a path prefix) and versioned, so the console is a path tree +
 * versioned secret editor.
 */
export type SecretsEngine = 'openbao';

export interface SecretsServerInfo {
  version: string;
  initialized: boolean;
  sealed: boolean;
  /** KV v2 mount the console operates on (e.g. "secret"). */
  mount: string;
}

/** One entry under a path prefix. Folders (sub-paths) end with "/" in KV v2. */
export interface SecretListEntry {
  name: string;
  isFolder: boolean;
}

export interface SecretVersionMeta {
  version: number;
  createdTime?: string;
  deleted: boolean;
  destroyed: boolean;
}

export interface SecretRead {
  path: string;
  /** KV pairs of the read version. */
  data: Record<string, string>;
  version: number;
  createdTime?: string;
  /** Full version history (newest last). */
  versions: SecretVersionMeta[];
}

export interface SecretsConnectParams {
  host: string;
  port: number;
  token: string;
  useTls: boolean;
  /** KV v2 mount path; defaults to "secret". */
  mount?: string;
}

/** A live session against one secrets server's KV v2 engine. */
export interface SecretsConnection {
  serverInfo(): Promise<SecretsServerInfo>;
  /** Children of a path prefix ("" = mount root). */
  list(prefix: string): Promise<SecretListEntry[]>;
  /** Read a secret (optionally a specific version); null when absent. */
  read(path: string, version?: number): Promise<SecretRead | null>;
  /** Create or update a secret; returns the new version number. */
  write(
    path: string,
    data: Record<string, string>,
  ): Promise<{ version: number }>;
  /** Soft-delete the latest version (recoverable). */
  deleteLatest(path: string): Promise<void>;
  /** Restore a soft-deleted version (KV v2 undelete). */
  undelete(path: string, version: number): Promise<void>;
  /** Remove the key and every version (irreversible). */
  destroy(path: string): Promise<void>;
  close(): Promise<void>;
}

export interface SecretsEngineAdapter {
  readonly engines: SecretsEngine[];
  connect(params: SecretsConnectParams): Promise<SecretsConnection>;
}

export const SECRETS_ENGINE_ADAPTERS = Symbol('SECRETS_ENGINE_ADAPTERS');

export interface SecretsProfile {
  engine: SecretsEngine;
  label: string;
  /** In-cluster API port. */
  port: number;
  /** Default KV v2 mount. */
  mount: string;
  /** Whether the API listener serves TLS (in-cluster we run plaintext). */
  useTls: boolean;
  /** Secret keys (first present wins) holding the access token. */
  tokenSecretKeys: string[];
  imagePattern: RegExp;
}

export const SECRETS_PROFILES: Record<SecretsEngine, SecretsProfile> = {
  openbao: {
    engine: 'openbao',
    label: 'OpenBao',
    port: 8200,
    mount: 'secret',
    useTls: false,
    tokenSecretKeys: ['OPENBAO_TOKEN', 'BAO_TOKEN'],
    imagePattern: /openbao/i,
  },
};

export function detectSecretsEngine(imageRef?: string): SecretsEngine | null {
  if (!imageRef) return null;
  for (const profile of Object.values(SECRETS_PROFILES)) {
    if (profile.imagePattern.test(imageRef)) return profile.engine;
  }
  return null;
}
