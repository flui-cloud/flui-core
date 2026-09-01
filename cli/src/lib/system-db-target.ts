/**
 * The two names `flui db tunnel` answers to itself instead of looking up an
 * application.
 *
 * They are the keys of the platform's own foundations, and the web console
 * refuses both absolutely — that refusal is not softened anywhere. This is the
 * other road: the CLI asks the API where the database is, opens the tunnel over
 * SSH and an in-cluster port-forward, and reads the password out of the Secret
 * with the cluster access it already had.
 *
 * The keys are used verbatim rather than as friendly aliases like `postgres`,
 * and that is the point. A tenant may legitimately name or slug an application
 * `postgres`, `getAppByName` matches case-insensitively on either, and an alias
 * would silently change which database an existing command opens. `platform-postgres`
 * is a name nothing else answers to.
 *
 * The Secret and its key live here and not on the wire: `db-secret.ts` states
 * the invariant as "the password deliberately never travels through the HTTP
 * API", and the narrow reading is that its address does not either. The cost is
 * that renaming a key in the bootstrap has to be followed here — which is why
 * the failure is a named error naming the Secret, and not a silent empty
 * password.
 */
export interface SystemDbTarget {
  /** Foundation key, used verbatim as the API path segment. */
  key: string;
  label: string;
  secretName: string;
  /** Candidate keys inside that Secret; the first present one wins. */
  secretKeys: string[];
}

export const SYSTEM_DB_TARGETS: readonly SystemDbTarget[] = [
  {
    key: 'platform-postgres',
    label: "Flui's own database",
    secretName: 'flui-secrets',
    secretKeys: ['DB_PASSWORD'],
  },
  {
    key: 'identity-provider',
    label: 'the identity provider database',
    secretName: 'zitadel-secrets',
    secretKeys: ['db-user-password'],
  },
];

/** The reserved target this name asks for, or null — in which case it names an application. */
export function systemDbTarget(
  name: string | undefined | null,
): SystemDbTarget | null {
  const wanted = (name ?? '').trim().toLowerCase();
  return SYSTEM_DB_TARGETS.find((t) => t.key === wanted) ?? null;
}

export const SYSTEM_DB_TARGET_NAMES = SYSTEM_DB_TARGETS.map((t) => t.key);
