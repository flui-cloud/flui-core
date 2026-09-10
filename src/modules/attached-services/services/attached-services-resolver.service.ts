import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '../../auth/entities/user.entity';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationEnvVar } from '../../applications/interfaces/source-config.interface';
import { ApplicationStatus } from '../../applications/enums/application-status.enum';
import {
  AttachedServiceRecord,
  AttachedServiceSpec,
  AttachedServicesPort,
  AttachedServicesReconcileContext,
  AttachedServicesReconcileResult,
} from '../../applications/interfaces/attached-services.port';
import { CatalogInstallerService } from '../../catalog/services/catalog-installer.service';
import { CatalogInstallRepository } from '../../catalog/repositories/catalog-install.repository';
import { CatalogAppDefinitionRepository } from '../../catalog/repositories/catalog-app-definition.repository';
import { CatalogInstallStatus } from '../../catalog/enums/catalog-install-status.enum';
import { CatalogAppType } from '../../catalog/enums/catalog-app-type.enum';
import { CatalogSpecBuildingBlock } from '../../catalog/interfaces/catalog-manifest.interface';
import { CatalogInstallEntity } from '../../catalog/entities/catalog-install.entity';
import { BlockConnectionUrlService } from '../../catalog/services/block-connection-url.service';
import {
  LinkedEnvError,
  ResolvedLinkedEnv,
  resolveLinkedEnvEntries,
} from '../attached-service-env.core';
import { engineHasConnectionUrl } from '../connection-url.core';
import {
  ApplicationServiceEntity,
  AttachedServiceStatus,
} from '../entities/application-service.entity';
import {
  ApplicationServicesRepository,
  desiredHashOf,
} from '../repositories/application-services.repository';

/** Name the spec reserves for the application itself. */
const RESERVED_SERVICE_NAME = 'app';

const LOCK_TTL_MS = 15 * 60 * 1000;
const DEFAULT_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 3000;

/**
 * One application, one instance, one lifecycle.
 *
 * `deploy.services[]` says an application needs a building block of its own.
 * This is what makes that true: it finds the instance the application already
 * owns, installs one when it does not, waits for it to actually run, and hands
 * back the environment that wires the two together — never a credential, always
 * a reference to the block's own Secret.
 *
 * It lives above both `ApplicationsModule` and `CatalogModule` because catalog
 * already imports applications; the deploy path reaches it through
 * `ATTACHED_SERVICES_PORT` rather than an import, so no cycle is created.
 *
 * Ownership is recorded in `application_services`, and the unique index on
 * `catalogInstallId` is what makes it impossible — in the database, not in a
 * code path two API replicas would each run — for two applications to claim one
 * Postgres.
 */
@Injectable()
export class AttachedServicesResolverService implements AttachedServicesPort {
  private readonly logger = new Logger(AttachedServicesResolverService.name);

  constructor(
    private readonly rows: ApplicationServicesRepository,
    private readonly applicationsRepo: ApplicationsRepository,
    private readonly installer: CatalogInstallerService,
    private readonly installRepo: CatalogInstallRepository,
    private readonly definitionRepo: CatalogAppDefinitionRepository,
    private readonly blockConnectionUrl: BlockConnectionUrlService,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
  ) {}

  // ─── Pre-flight ────────────────────────────────────────────────────────────

  async validate(services: AttachedServiceSpec[]): Promise<void> {
    if (!services?.length) return;

    const seen = new Set<string>();
    for (const svc of services) {
      this.assertValidServiceName(svc, seen);
      seen.add(svc.name);

      const definition = await this.definitionRepo.findActiveBySlug(svc.block);
      this.assertValidBlock(svc, definition);
      this.assertValidEnvMapping(svc, definition);
    }
  }

  private assertValidServiceName(
    svc: AttachedServiceSpec,
    seen: Set<string>,
  ): void {
    if (svc.name === RESERVED_SERVICE_NAME) {
      throw new BadRequestException(
        `deploy.services: "${RESERVED_SERVICE_NAME}" is reserved for the application itself — name the service after what it is (db, cache, …).`,
      );
    }
    if (seen.has(svc.name)) {
      throw new BadRequestException(
        `deploy.services: two services are called "${svc.name}". Each name is how its env is addressed, so they must differ.`,
      );
    }
  }

  private assertValidBlock(
    svc: AttachedServiceSpec,
    definition: Awaited<
      ReturnType<CatalogAppDefinitionRepository['findActiveBySlug']>
    >,
  ): asserts definition is NonNullable<typeof definition> {
    if (!definition) {
      throw new BadRequestException(
        `deploy.services["${svc.name}"]: no catalog block called "${svc.block}".`,
      );
    }
    if (definition.appType !== CatalogAppType.BUILDING_BLOCK) {
      throw new BadRequestException(
        `deploy.services["${svc.name}"]: "${svc.block}" is a ${definition.appType}, not a building block. A full catalog app is installed on its own, not attached to an application.`,
      );
    }

    // `resources` is in the published schema, and this cannot honour it: `installBuildingBlock`
    // takes no size. Accepting it would install a block at the catalog's own defaults while the
    // manifest says otherwise — a declared field that produces nothing, which is the failure the
    // engine exists to refuse. Refusing is loud and fixable; ignoring it hands someone a database
    // that is not the size they asked for and says nothing.
    if (svc.resources && Object.keys(svc.resources).length > 0) {
      throw new BadRequestException(
        `deploy.services["${svc.name}"].resources is not honoured yet: the block would be installed at the catalog's own size, not this one. Remove it, or size the block after it is installed.`,
      );
    }
  }

  private assertValidEnvMapping(
    svc: AttachedServiceSpec,
    definition: NonNullable<
      Awaited<ReturnType<CatalogAppDefinitionRepository['findActiveBySlug']>>
    >,
  ): void {
    const spec = definition.manifest.spec as CatalogSpecBuildingBlock;
    const declared = new Set((spec.env ?? []).map((e) => e.name));
    for (const entry of svc.env ?? []) {
      if (entry.fromBBEnv && !declared.has(entry.fromBBEnv)) {
        throw new BadRequestException(
          `deploy.services["${svc.name}"].env "${entry.name}": fromBBEnv "${entry.fromBBEnv}" is not a variable "${svc.block}" declares.`,
        );
      }
      if (entry.fromService === 'url' && !engineHasConnectionUrl(spec.engine)) {
        throw new BadRequestException(
          `deploy.services["${svc.name}"].env "${entry.name}": fromService: url is not available for "${svc.block}" — it declares no database engine, so it has no connection URL. Use fromService: host / port, or fromBBEnv.`,
        );
      }
    }
  }

  /**
   * Names the application's own `deploy.env` must not also use.
   *
   * A collision is silent damage: whichever list is merged second wins, and the
   * loser is a variable someone declared and can still read in git.
   */
  collidingEnvNames(
    services: AttachedServiceSpec[],
    appEnvNames: Iterable<string>,
  ): string[] {
    const own = new Set(appEnvNames);
    const clash: string[] = [];
    for (const svc of services ?? []) {
      for (const entry of svc.env ?? []) {
        if (own.has(entry.name)) clash.push(entry.name);
      }
    }
    return clash;
  }

  // ─── Reconcile ─────────────────────────────────────────────────────────────

  async reconcile(
    ctx: AttachedServicesReconcileContext,
  ): Promise<AttachedServicesReconcileResult> {
    const services = ctx.services ?? [];

    // The row is written BEFORE the manifest is judged, and the order is the whole point.
    //
    // `validate` used to run first. When it refused — an unknown block slug, a `fromBBEnv` the
    // block does not declare, `fromService: url` on a block with no engine — it threw with no row
    // written anywhere. On the push path that is a 500 to the GitHub Action and nothing else: the
    // image is already recorded, so the next `Deploy` press reaches
    // `assertAttachedServicesReady`, finds no row that is not READY (because there is no row at
    // all), and lets the application through GREEN without the service its own manifest declares.
    // A row in PENDING is what makes that gate able to see the refusal.
    const pending: string[] = [];
    for (const svc of services) {
      const row = await this.rows.upsertDesired(ctx.applicationId, {
        name: svc.name,
        block: svc.block,
        envSpec: svc.env ?? [],
        resources: (svc.resources as Record<string, unknown>) ?? null,
      });
      pending.push(row.id);
    }

    try {
      await this.validate(services);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      for (const id of pending) await this.rows.markFailed(id, reason);
      throw err;
    }

    const declaredNames = new Set(services.map((s) => s.name));
    const ownedNames = new Set<string>();
    for (const svc of services) {
      for (const entry of svc.env ?? []) ownedNames.add(entry.name);
    }

    for (const stale of await this.rows.listByApplication(ctx.applicationId)) {
      if (declaredNames.has(stale.name)) continue;
      // Its env names stay owned for one more merge, which is what lets them be
      // REMOVED from the application instead of pointing at a Secret nobody
      // answers for.
      for (const entry of stale.envSpec ?? []) ownedNames.add(entry.name);
      // The manifest stopped declaring it. The row is retired so the deploy
      // stops waiting on it, but the block is NOT uninstalled here: deleting a
      // database because a line left a file is not something a push should do
      // without being asked. The sweep and the removal cascade are where a
      // person is shown what it holds first.
      await this.rows.retire(stale.id);
      this.logger.warn(
        `application ${ctx.applicationId}: service "${stale.name}" (${stale.block}) is no longer declared. ` +
          `The row is retired; its install ${stale.catalogInstallId ?? '(none)'} is left running and now belongs to nobody — remove it from the catalog when you have its data.`,
      );
    }

    const env: ResolvedLinkedEnv[] = [];
    const attachments: AttachedServiceRecord[] = [];

    for (const svc of services) {
      // Idempotent, and the row already exists from the pre-validation pass above: this re-reads it
      // rather than creating it.
      const row = await this.rows.upsertDesired(ctx.applicationId, {
        name: svc.name,
        block: svc.block,
        envSpec: svc.env ?? [],
        resources: (svc.resources as Record<string, unknown>) ?? null,
      });
      const resolved = await this.reconcileOne(row, svc, ctx);
      env.push(...resolved.env);
      attachments.push(resolved.record);
    }

    return { env, attachments, ownedNames: [...ownedNames] };
  }

  private async reconcileOne(
    row: ApplicationServiceEntity,
    svc: AttachedServiceSpec,
    ctx: AttachedServicesReconcileContext,
  ): Promise<{ env: ResolvedLinkedEnv[]; record: AttachedServiceRecord }> {
    const token = await this.rows.acquireLock(row.id, LOCK_TTL_MS);
    if (!token) {
      throw new BadRequestException(
        `Service "${row.name}" of this application is already being provisioned by another deploy. ` +
          `Wait for it to finish and push again.`,
      );
    }

    try {
      const install = await this.ensureInstall(row, svc, ctx);
      const blockApp = await this.blockApplicationOf(install, row);
      await this.stampOwnership(blockApp, ctx.applicationId, row.name);

      const env = await this.wire(row, svc, install, blockApp);

      await this.rows.markReady(row.id, {
        catalogInstallId: install.id,
        bbApplicationId: blockApp.id,
        appliedHash: desiredHashOf({
          name: svc.name,
          block: svc.block,
          envSpec: svc.env ?? [],
          resources: (svc.resources as Record<string, unknown>) ?? null,
        }),
      });

      return {
        env,
        record: {
          id: row.id,
          name: row.name,
          block: row.block,
          status: AttachedServiceStatus.READY,
          statusReason: null,
          catalogInstallId: install.id,
          bbApplicationId: blockApp.id,
        },
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.rows.markFailed(row.id, reason);
      throw err;
    } finally {
      await this.rows.releaseLock(row.id, token);
    }
  }

  /**
   * The instance this application owns, installing one only when it owns none.
   *
   * Reuse is decided by the row, not by a search of the cluster: an install
   * this application's row points at is this application's, and anything else
   * belongs to somebody. That is the difference between "redeploy" and
   * "second Postgres with a 10Gi volume nobody will ever look at".
   */
  private async ensureInstall(
    row: ApplicationServiceEntity,
    svc: AttachedServiceSpec,
    ctx: AttachedServicesReconcileContext,
  ): Promise<CatalogInstallEntity> {
    if (row.catalogInstallId) {
      const existing = await this.installRepo.findById(row.catalogInstallId);
      if (
        existing &&
        existing.status !== CatalogInstallStatus.UNINSTALLED &&
        existing.status !== CatalogInstallStatus.UNINSTALLING
      ) {
        if (existing.status === CatalogInstallStatus.RUNNING) return existing;
        // Still coming up from an earlier attempt — wait for the one that
        // exists instead of starting a second.
        return this.waitForRunning(existing.id, ctx);
      }
      this.logger.warn(
        `application ${ctx.applicationId}: service "${row.name}" pointed at install ` +
          `${row.catalogInstallId}, which is gone. Installing a fresh ${row.block}.`,
      );
    }

    // The email is what puts the block in the OWNER's namespace, and the
    // cross-application `secretKeyRef` only resolves inside one namespace. A
    // background re-apply (a push, not a person) carries no email, so it is
    // read from the application's owner rather than defaulted — a block that
    // landed in `default` would be unreachable and the failure would show up
    // as a pod that never starts, minutes later and somewhere else.
    const userEmail =
      ctx.userEmail ?? (await this.ownerEmailOf(ctx.applicationId));

    const { install } = await this.installer.installBuildingBlock(
      svc.block,
      ctx.clusterId,
      ctx.userId,
      userEmail,
    );
    this.logger.log(
      `application ${ctx.applicationId}: installing ${svc.block} as service "${svc.name}" (install ${install.id})`,
    );
    return this.waitForRunning(install.id, ctx);
  }

  private async waitForRunning(
    installId: string,
    ctx: AttachedServicesReconcileContext,
  ): Promise<CatalogInstallEntity> {
    const timeoutMs = ctx.waitTimeoutMs ?? DEFAULT_WAIT_MS;
    const pollMs = ctx.pollIntervalMs ?? DEFAULT_POLL_MS;
    const deadline = Date.now() + timeoutMs;
    let last: CatalogInstallEntity | null = null;

    for (;;) {
      const current = await this.installRepo.findById(installId);
      if (!current) {
        throw new Error(
          `Install ${installId} disappeared while waiting for it`,
        );
      }
      last = current;
      if (current.status === CatalogInstallStatus.RUNNING) return current;
      if (current.status === CatalogInstallStatus.FAILED) {
        throw new Error(
          `Attached service install ${installId} failed: ${current.errorMessage ?? 'unknown'}`,
        );
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }

    throw new Error(
      `Attached service install ${installId} did not reach RUNNING within ${timeoutMs}ms (last status=${last?.status})`,
    );
  }

  private async blockApplicationOf(
    install: CatalogInstallEntity,
    row: ApplicationServiceEntity,
  ): Promise<ApplicationEntity> {
    const id = install.applicationIds?.[0];
    if (!id) {
      throw new Error(
        `Attached service "${row.name}": install ${install.id} is RUNNING but owns no application`,
      );
    }
    const app = await this.applicationsRepo.findById(id);
    if (!app) {
      throw new Error(
        `Attached service "${row.name}": application ${id} of install ${install.id} not found`,
      );
    }
    return app;
  }

  /**
   * Say in the cluster who the block belongs to.
   *
   * Without it a stray Postgres is indistinguishable from a deliberate one, and
   * the only record of the attachment is a row in our database — which is
   * exactly the state an orphan sweep cannot act on from the outside.
   */
  private async stampOwnership(
    blockApp: ApplicationEntity,
    consumerId: string,
    serviceName: string,
  ): Promise<void> {
    const labels = {
      ...(blockApp.labels as Record<string, string> | undefined),
    };
    if (
      labels['flui.cloud/attached-to'] === consumerId &&
      labels['flui.cloud/attached-as'] === serviceName
    ) {
      return;
    }
    labels['flui.cloud/attached-to'] = consumerId;
    labels['flui.cloud/attached-as'] = serviceName;
    await this.applicationsRepo.update(blockApp.id, { labels });
    blockApp.labels = labels;
  }

  private async wire(
    row: ApplicationServiceEntity,
    svc: AttachedServiceSpec,
    install: CatalogInstallEntity,
    blockApp: ApplicationEntity,
  ): Promise<ResolvedLinkedEnv[]> {
    const definition = await this.definitionRepo.findById(
      install.catalogAppDefinitionId,
    );
    if (!definition) {
      throw new Error(
        `Attached service "${row.name}": catalog definition ${install.catalogAppDefinitionId} not found`,
      );
    }
    const spec = definition.manifest.spec as CatalogSpecBuildingBlock;

    const wantsUrl = (svc.env ?? []).some((e) => e.fromService === 'url');
    const connectionUrlKey = wantsUrl
      ? await this.blockConnectionUrl.ensureOnExisting(blockApp, spec.engine)
      : null;

    try {
      return resolveLinkedEnvEntries(svc.env ?? [], {
        ref: svc.block,
        host: `${blockApp.slug}-svc.${blockApp.k8sNamespace}.svc.cluster.local`,
        port: spec.ports?.[0]?.internal ?? blockApp.port,
        secretName: `${blockApp.slug}-secret`,
        declaredEnv: (spec.env ?? []).map((e) => ({
          name: e.name,
          secret: isSecretDeclaration(e),
        })),
        appEnv: Object.fromEntries(
          ((blockApp.env as ApplicationEnvVar[] | undefined) ?? [])
            .filter((e) => !e.secret && !e.externalSecretRef)
            .map((e) => [e.name, e.value ?? '']),
        ),
        connectionUrlKey,
      });
    } catch (err) {
      if (err instanceof LinkedEnvError) {
        throw new BadRequestException(
          `deploy.services["${svc.name}"]: ${err.message}`,
        );
      }
      throw err;
    }
  }

  // ─── Read / teardown ───────────────────────────────────────────────────────

  async attachmentsOf(applicationId: string): Promise<AttachedServiceRecord[]> {
    const rows = await this.rows.listByApplication(applicationId);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      block: r.block,
      status: r.status,
      statusReason: r.statusReason,
      catalogInstallId: r.catalogInstallId,
      bbApplicationId: r.bbApplicationId,
    }));
  }

  async detachAll(
    applicationId: string,
    userId?: string,
  ): Promise<AttachedServiceRecord[]> {
    const rows = await this.rows.listByApplication(applicationId);
    const detached: AttachedServiceRecord[] = [];

    for (const row of rows) {
      if (row.catalogInstallId) {
        try {
          await this.installer.uninstall(row.catalogInstallId, userId);
        } catch (err) {
          // Already gone, or already on its way out: the row must still be
          // released, otherwise the application cannot be deleted at all.
          this.logger.warn(
            `detaching "${row.name}" of ${applicationId}: uninstall of ${row.catalogInstallId} ` +
              `did not start (${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
      await this.rows.markDetached(row.id);
      detached.push({
        id: row.id,
        name: row.name,
        block: row.block,
        status: AttachedServiceStatus.DETACHED,
        statusReason: null,
        catalogInstallId: row.catalogInstallId,
        bbApplicationId: row.bbApplicationId,
      });
    }
    return detached;
  }

  private async ownerEmailOf(
    applicationId: string,
  ): Promise<string | undefined> {
    const app = await this.applicationsRepo.findById(applicationId);
    if (!app?.userId) return undefined;
    const user = await this.users.findOne({ where: { id: app.userId } });
    return user?.email;
  }

  /** Applications whose block is running but whose owner is gone. */
  async isBlockRunning(blockApplicationId: string): Promise<boolean> {
    const app = await this.applicationsRepo.findById(blockApplicationId);
    return (
      !!app &&
      !app.deletedAt &&
      (app.status === ApplicationStatus.RUNNING ||
        app.status === ApplicationStatus.DEGRADED)
    );
  }
}

/** Same test the linking service applies — a block env is secret when it is generated or sensitive. */
function isSecretDeclaration(e: { valueFrom?: unknown }): boolean {
  const vf = e.valueFrom as Record<string, any> | undefined;
  if (!vf) return false;
  return 'generate' in vf || ('userInput' in vf && !!vf.userInput?.sensitive);
}
