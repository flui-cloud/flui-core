/**
 * The seam between an application deploy and the catalog that provisions the
 * services it attached to itself.
 *
 * It exists because `CatalogModule` imports `ApplicationsModule`, so the
 * orchestration cannot live inside either: the implementation sits in a module
 * above both and reaches this side through a token. Nothing under
 * `applications/` imports anything from `catalog/` to use it.
 *
 * Every method is optional at runtime — the token is injected with `@Optional()`
 * so a deploy still works when the implementing module is absent (tests, a
 * trimmed build). A manifest that DECLARES services when the port is missing is
 * refused rather than deployed without them; see `assertAttachable`.
 */
export const ATTACHED_SERVICES_PORT = 'ATTACHED_SERVICES_PORT';

export interface AttachedServiceEnvSpec {
  name: string;
  fromService?: 'host' | 'port' | 'url';
  fromBBEnv?: string;
  value?: string;
}

export interface AttachedServiceSpec {
  name: string;
  block: string;
  env: AttachedServiceEnvSpec[];
  /**
   * `unknown`, not the spec's resource shape: this file is the seam and must
   * name no type either side owns. It is stored verbatim and handed back to the
   * catalog, which is the only thing that reads it.
   */
  resources?: unknown;
}

export interface AttachedServiceEnvResult {
  name: string;
  value: string;
  secret: boolean;
  externalSecretRef?: { secretName: string; key: string };
}

export interface AttachedServiceRecord {
  id: string;
  name: string;
  block: string;
  status: string;
  statusReason: string | null;
  catalogInstallId: string | null;
  bbApplicationId: string | null;
}

export interface AttachedServicesReconcileContext {
  applicationId: string;
  clusterId: string;
  userId?: string;
  userEmail?: string;
  services: AttachedServiceSpec[];
  /** How long to wait for a freshly installed block to reach RUNNING. */
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface AttachedServicesReconcileResult {
  /** Env the application must carry to reach its services, ready to merge. */
  env: AttachedServiceEnvResult[];
  attachments: AttachedServiceRecord[];
  /**
   * Every env name the attachment machinery is authoritative over on this
   * application — including names from services it just STOPPED declaring.
   * Without the second half, a `link` entry pointing at a Secret nobody owns
   * any more would stay on the row and keep the pod from starting.
   */
  ownedNames: string[];
}

export interface AttachedServicesPort {
  /**
   * Refuse a manifest whose `deploy.services[]` cannot be honoured, BEFORE
   * anything is created — an unknown block, a block that is not a building
   * block, a duplicate or reserved name, a `fromService: url` on a block with
   * no URL form. Same call on `--validate-only` and on the real deploy, so the
   * preview and the deploy give one answer.
   */
  validate(services: AttachedServiceSpec[]): Promise<void>;

  /**
   * Bring an application's attached services to what its manifest declares:
   * reuse the instance it already owns, otherwise install the block and wait
   * for it to run, then compute the env that wires the two together.
   */
  reconcile(
    ctx: AttachedServicesReconcileContext,
  ): Promise<AttachedServicesReconcileResult>;

  /** The rows an application owns — read by the deploy gate and the removal preview. */
  attachmentsOf(applicationId: string): Promise<AttachedServiceRecord[]>;

  /**
   * Uninstall every block an application attached, and mark the rows detached.
   * Returns what it started, so a removal can report it instead of taking the
   * data away silently.
   */
  detachAll(
    applicationId: string,
    userId?: string,
  ): Promise<AttachedServiceRecord[]>;
}
