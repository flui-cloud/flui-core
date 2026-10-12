import { BadRequestException } from '@nestjs/common';
import { In, Repository } from 'typeorm';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { DbMigrationEntity } from '../../db-lifecycle/entities/db-migration.entity';
import { AppMigrationEntity } from '../../app-migration/entities/app-migration.entity';
import { FullMigrationEntity } from '../entities/full-migration.entity';
import {
  APP_ACTIVE,
  DB_ACTIVE,
  FM_ACTIVE,
} from '../utils/full-migration-service.core';
import { DbConnectionRewireService } from './db-connection-rewire.service';

/** What must hold before a full migration starts on an application and its database. */
export class FullMigrationPreconditions {
  constructor(
    private readonly fmRepo: Repository<FullMigrationEntity>,
    private readonly dbMigRepo: Repository<DbMigrationEntity>,
    private readonly appMigRepo: Repository<AppMigrationEntity>,
    private readonly appsRepo: ApplicationsRepository,
    private readonly rewire: DbConnectionRewireService,
  ) {}

  /**
   * A pooled source's pooler is paused for good once the database moves:
   * another application still using it would be left waiting, then failing.
   */
  async assertOnlyConsumer(
    app: { id: string },
    dbApp: ApplicationEntity,
  ): Promise<void> {
    const others = (await this.appsRepo.findByClusterId(dbApp.clusterId))
      .filter((a) => a.id !== app.id && a.id !== dbApp.id)
      .filter((a) => this.rewire.referencesDb(a, dbApp));
    if (others.length) {
      throw new BadRequestException(
        `Other applications use the database ${dbApp.name ?? dbApp.slug}: ${others
          .map((a) => a.name ?? a.slug)
          .join(
            ', ',
          )}. Moving it with one of them would leave the others on a database that stops taking connections. Move or repoint them first.`,
      );
    }
  }

  async assertNoConflict(appId: string, dbAppId: string): Promise<void> {
    const fm = await this.fmRepo.findOne({
      where: [
        { appId, status: In(FM_ACTIVE) },
        { dbAppId, status: In(FM_ACTIVE) },
      ],
    });
    if (fm) {
      throw new BadRequestException(
        `An in-progress full-migration (${fm.id}) already covers this app or DB`,
      );
    }
    const dbm = await this.dbMigRepo.findOne({
      where: { srcAppId: dbAppId, status: In(DB_ACTIVE) },
    });
    if (dbm) {
      throw new BadRequestException(
        `The database ${dbAppId} already has an in-progress migration (${dbm.id})`,
      );
    }
    const appm = await this.appMigRepo.findOne({
      where: { srcAppId: appId, status: In(APP_ACTIVE) },
    });
    if (appm) {
      throw new BadRequestException(
        `The application ${appId} already has an in-progress migration (${appm.id})`,
      );
    }
  }
}
