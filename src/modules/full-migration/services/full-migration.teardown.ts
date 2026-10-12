import { Repository } from 'typeorm';
import { DbMigrationService } from '../../db-lifecycle/services/db-migration.service';
import { DbReplicationService } from '../../db-lifecycle/services/db-replication.service';
import { DbMigrationEntity } from '../../db-lifecycle/entities/db-migration.entity';
import { DbPoolerCutService } from '../../db-lifecycle/services/db-pooler-cut.service';
import { AppMigrationService } from '../../app-migration/services/app-migration.service';
import { FullMigrationEntity } from '../entities/full-migration.entity';
import { FullStagingMode } from '../enums/full-migration.enum';

type Warn = (id: string, what: string, e: unknown) => void;

/** Best-effort teardown of both legs once an abort has claimed the migration. */
export class FullMigrationTeardown {
  constructor(
    private readonly dbMigRepo: Repository<DbMigrationEntity>,
    private readonly dbMig: DbMigrationService,
    private readonly repl: DbReplicationService,
    private readonly appMig: AppMigrationService,
    private readonly warn: Warn,
    private readonly poolerCut?: DbPoolerCutService,
  ) {}

  async tearDown(id: string, fm: FullMigrationEntity): Promise<void> {
    if (fm.appMigrationId) {
      // A bridge opened ahead of the fence is undone first: the source serves
      // again before anything on the destination is torn down.
      await this.appMig
        .rollbackBridge(fm.appMigrationId, true)
        .catch((e: unknown) => this.warn(id, 'bridge rollback', e));
    }
    await this.unforward(fm);
    if (fm.appMigrationId) {
      await this.appMig
        .abort(fm.appMigrationId, true)
        .catch((e: unknown) => this.warn(id, 'app-leg abort', e));
    }
    // Variant B: unfence the dst (fenced at staging) after the app leg is torn
    // down and before the db leg abort — never leave a fenced dst while the src
    // is still writable, and unblock the link-teardown DDL.
    if (fm.stagingMode === FullStagingMode.LIVE_FENCED && fm.dbMigrationId) {
      const dbChild = await this.dbMigRepo.findOne({
        where: { id: fm.dbMigrationId },
      });
      if (dbChild?.dstAppId) {
        await this.repl
          .unfence(dbChild.dstAppId)
          .catch((e: unknown) => this.warn(id, 'dst unfence', e));
      }
    }
    if (fm.dbMigrationId) {
      await this.dbMig
        .abort(fm.dbMigrationId, true)
        .catch((e: unknown) => this.warn(id, 'db-leg abort', e));
    }
  }

  /** A destination pooler still forwarding to the source goes back to its own database. */
  private async unforward(fm: FullMigrationEntity): Promise<void> {
    if (!this.poolerCut || !fm.dbMigrationId) return;
    const dbChild = await this.dbMigRepo.findOne({
      where: { id: fm.dbMigrationId },
    });
    if (!dbChild?.linkId || !dbChild.poolerCut?.poolers?.length) return;
    await this.poolerCut
      .unforward(dbChild.linkId)
      .catch((e: unknown) => this.warn(fm.id, 'pooler unforward', e));
  }
}
