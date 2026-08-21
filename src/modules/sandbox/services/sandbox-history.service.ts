import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { DbBackupService } from '../../database-console/services/db-backup.service';
import {
  declaredEngineOf,
  detectEngineFromImage,
} from '../../database-console/engine/engine-profile';
import { SandboxTenantEntity } from '../entities/sandbox-tenant.entity';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';

/** Structural, because a read stream and a write stream do not share a type. */
interface CleanableStream {
  on(event: 'error', listener: () => void): unknown;
  once(event: 'close', listener: () => void): unknown;
  destroy(): unknown;
  readonly closed: boolean;
}

/**
 * A file stream that is safe to walk away from.
 *
 * `createReadStream` and `createWriteStream` open their descriptor
 * asynchronously, so a copy that fails before the open completes leaves a
 * stream that will emit `error` with nobody listening — and an unhandled
 * `error` on a stream takes the process down. That is the failure path of every
 * tenancy build, so it has to be the safe one: the real reason is already
 * carried by the rejection from dump or restore, and this listener exists only
 * so the abandoned stream cannot raise a second, fatal one.
 */
function abandonable<T extends CleanableStream>(stream: T): T {
  stream.on('error', () => undefined);
  return stream;
}

/**
 * Close a stream and wait until it really is closed.
 *
 * `destroy()` returns immediately, and on a stream whose open is still in
 * flight the open goes on to complete *afterwards* — creating the file a moment
 * after the cleanup deleted it. Waiting for `close` is what makes "delete the
 * dump" mean it: every build makes one of these, so one left behind per failure
 * is a copy of a database accumulating in a temp directory.
 */
function closed(stream: CleanableStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.closed) return resolve();
    stream.once('close', () => resolve());
    stream.destroy();
  });
}

export interface HistoryCopyOutcome {
  copied: boolean;
  seconds: number;
  /** Machine-readable when nothing was copied. */
  reason?: string;
}

/**
 * Giving a newly built tenancy a past.
 *
 * The demo used to be convincing by accident. A tenancy sat in the reserve for
 * a day before anyone claimed it, and the seeded application wrote to its own
 * database the whole time — so the visitor opened the SQL console onto seventy
 * thousand rows and graphs with a day of shape. Nobody designed that. It was
 * queue time wearing the costume of content, and building tenancies on demand
 * takes it away silently: nothing breaks, no test fails, the demo simply stops
 * convincing.
 *
 * So the history is copied instead of waited for. A reference instance of the
 * same application runs permanently and accumulates for real; every new tenancy
 * receives a copy of its database. The rows are not fabricated — they were
 * written by the same software doing the same work, just earlier and somewhere
 * else — and once copied they belong to the guest, who can write to them.
 *
 * Two things this deliberately does not do:
 *
 * 1. **It does not touch metrics or logs.** Those live in time-series stores, in
 *    the guest's own space, and are read as measurements of the guest's own
 *    load. Copying somebody else's would be lying about what the product
 *    measures — the one thing an evaluator is using telemetry to judge. The
 *    graphs start at zero, which is also what happens to a real customer.
 * 2. **It never copies from another tenancy.** The source is a dedicated
 *    reference instance, never a guest, however synthetic that guest's rows
 *    might be. One guest's rows appearing in another guest's area is the exact
 *    shape of the failure the whole fence exists to prevent, and it would be no
 *    less true for being harmless data.
 */
@Injectable()
export class SandboxHistoryService {
  private readonly logger = new Logger(SandboxHistoryService.name);
  private warnedAboutMissingReference = false;

  constructor(
    private readonly backups: DbBackupService,
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
  ) {}

  /**
   * Copy the reference instance's database into a tenancy that has just been
   * built.
   *
   * Runs while the tenancy is still warm, before anybody holds it — measured at
   * about 1.7s for a day of accumulated rows, which would fit inside the
   * entrance too, but there is no reason to spend a visitor's seconds on work
   * that can be done while nobody is waiting.
   *
   * Reports rather than throws. A tenancy with a shallow history is a worse
   * demo; a tenancy that failed to build is no demo at all.
   */
  async copyInto(tenant: SandboxTenantEntity): Promise<HistoryCopyOutcome> {
    const startedAt = Date.now();
    const seconds = () => (Date.now() - startedAt) / 1000;
    try {
      return await this.attemptCopy(tenant, seconds);
    } catch (error) {
      // Everything, including the two lookups: a hiccup while reading the
      // application rows must not turn a tenancy that built perfectly well into
      // a failed one over the part that is only decoration.
      this.logger.warn(
        `Could not give ${tenant.namespace} a history: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { copied: false, seconds: seconds(), reason: 'copy_failed' };
    }
  }

  private async attemptCopy(
    tenant: SandboxTenantEntity,
    seconds: () => number,
  ): Promise<HistoryCopyOutcome> {
    const source = await this.referenceDatabase(tenant.clusterId);
    if (!source) {
      // Once per process: an instance running without a reference is a choice,
      // not an incident, and a line per build would bury the real warnings.
      if (!this.warnedAboutMissingReference) {
        this.warnedAboutMissingReference = true;
        this.logger.warn(
          `No reference database in namespace ${this.config.historyNamespace} — tenancies will start with only what the seed writes in its first minute. See SandboxHistoryService.`,
        );
      }
      return { copied: false, seconds: seconds(), reason: 'no_reference' };
    }

    const target = await this.databaseIn(tenant.clusterId, tenant.namespace);
    if (!target) {
      return { copied: false, seconds: seconds(), reason: 'no_target' };
    }

    // Unique per attempt, not per tenancy: a retry must never read a dump left
    // behind by the attempt that failed, and two of these must never be able to
    // meet on the same path.
    const dumpFile = join(
      tmpdir(),
      `flui-sandbox-history-${tenant.id}-${randomUUID()}.sql`,
    );
    try {
      // Through a file rather than pipe to pipe: 5MB is nothing, and a stalled
      // reader on one end of a stream pair would hang a build for its whole
      // timeout instead of failing.
      const out = abandonable(createWriteStream(dumpFile));
      try {
        await this.backups.dump(
          { dbInstallId: source.id, fluiUserId: source.userId ?? '' },
          out,
        );
      } finally {
        await closed(out);
      }

      const back = abandonable(createReadStream(dumpFile));
      try {
        await this.backups.restore(
          { dbInstallId: target.id, fluiUserId: tenant.userId ?? '' },
          back,
        );
      } finally {
        await closed(back);
      }
      this.logger.log(
        `Copied the reference history into ${tenant.namespace} in ${seconds().toFixed(1)}s`,
      );
      return { copied: true, seconds: seconds() };
    } finally {
      await unlink(dumpFile).catch(() => undefined);
    }
  }

  /**
   * The instance that has been running and accumulating.
   *
   * Found by where it lives rather than by an id in the environment, so that
   * standing one up is an ordinary install into a known namespace and not a
   * configuration change on the API.
   */
  private referenceDatabase(
    clusterId: string,
  ): Promise<ApplicationEntity | null> {
    return this.databaseIn(clusterId, this.config.historyNamespace);
  }

  /** The one application in a namespace that is a SQL database. */
  private async databaseIn(
    clusterId: string,
    namespace: string,
  ): Promise<ApplicationEntity | null> {
    const apps = await this.applications.find({
      where: { clusterId, k8sNamespace: namespace },
    });
    return (
      apps.find(
        (app) =>
          (declaredEngineOf(app.labels) ??
            detectEngineFromImage(app.imageRef)) === 'postgres',
      ) ?? null
    );
  }
}
