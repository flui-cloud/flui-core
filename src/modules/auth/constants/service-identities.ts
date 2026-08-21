import { IdentityRole } from '../entities/user.entity';

/**
 * The non-interactive identities this installation ships with — declared here,
 * never inferred from the shape of a row.
 *
 * The rule that matters is the one this list makes enforceable: an API key whose
 * `userId` no longer resolves to a user is **refused**. Without this list such
 * a row falls through to a hardcoded `service-account` principal with
 * `isAdmin: true`, so the key of a deleted person does not stop working — it is
 * promoted, and `isAdmin` short-circuits `filterReadable`, `AppAccessGuard`, the
 * sandbox fence and the MCP scope resolver in one step.
 */
export interface ServiceIdentityDef {
  /** Principal id: what `api_keys.userId` holds, and what an IAM binding of type `service_account` addresses. */
  id: string;
  /** The key name that declares this identity. Rows seeded before this file carry no `userId`. */
  keyName: string;
  email: string;
  role: IdentityRole;
  /**
   * Still true, and not because nobody looked.
   *
   * Both identities below are install-time credentials, and the work they are
   * observably asked to do is admin-gated end to end:
   *   - `POST /auth/bootstrap` is `@Admin()` (AdminGuard reads `isAdmin`);
   *   - `POST /firewalls/cluster/:id/enable` and `GET /firewalls/cluster/:id`
   *     sit behind `@RequireSection('firewall')`, i.e. `cluster:manage` at
   *     global scope;
   *   - the cluster writes (`PATCH :id/metadata`, `POST :id/byos-nodes`,
   *     `POST :id/byos-vnet`) belong to the `infrastructure` section.
   * On top of that, `flui dev creds` copies this same key into the operator's
   * profile, where every CLI command uses it — so the honest minimum for the
   * credential *as it is consumed today* is "everything".
   *
   * Narrowing it is therefore not a value to edit here: it needs the caller
   * split into an install credential and an operator credential, which is the
   * author's decision. See the diary in AGENT_S1_CREDENZIALI.md.
   */
  isAdmin: boolean;
  /** `userId` values written by earlier versions that still mean this identity. */
  legacyUserIds: string[];
  /** Grants carried by the credential itself. Empty = nothing declared yet, not "all". */
  scopes: string[];
}

export const SERVICE_IDENTITY: Record<string, ServiceIdentityDef> = {
  /** Seeded from `FLUI_CLI_API_KEY` at boot; the credential `flui env create` installs with. */
  CLI_BOOTSTRAP: {
    id: 'cli-bootstrap',
    keyName: 'cli-bootstrap',
    email: 'cli@flui.internal',
    role: IdentityRole.ADMIN,
    isAdmin: true,
    legacyUserIds: ['service-account'],
    scopes: [],
  },
  /** Minted by `configure-auth-mode` for M2M access in local auth mode. */
  CLI_SERVICE_ACCOUNT: {
    id: 'cli-service-account',
    keyName: 'cli-service-account',
    email: 'cli@flui.internal',
    role: IdentityRole.ADMIN,
    isAdmin: true,
    legacyUserIds: ['service-account'],
    scopes: [],
  },
};

const DEFS: ServiceIdentityDef[] = Object.values(SERVICE_IDENTITY);

/**
 * The declared identity a key row stands for, or null.
 *
 * A row qualifies only by its declared name plus a `userId` this file
 * recognises — null (seeded rows), the identity's own id, or a legacy sentinel.
 * A key carrying a real user id that happens to be gone matches nothing, which
 * is the point.
 */
export function serviceIdentityFor(record: {
  name: string;
  userId: string | null;
}): ServiceIdentityDef | null {
  const def = DEFS.find((d) => d.keyName === record.name);
  if (!def) return null;
  const bound =
    record.userId === null ||
    record.userId === undefined ||
    record.userId === def.id ||
    def.legacyUserIds.includes(record.userId);
  return bound ? def : null;
}
