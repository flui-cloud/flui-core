import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AppMigrationEntity } from '../../app-migration/entities/app-migration.entity';
import { DbMigrationEntity } from '../../db-lifecycle/entities/db-migration.entity';
import { DbMigrationViewService } from '../../db-lifecycle/services/db-migration-view.service';
import {
  FullMigrationReadView,
  fullMigrationReadView,
} from '../utils/full-migration-view';
import {
  FullMigrationService,
  FullMigrationView,
} from './full-migration.service';

/** Full migrations as every surface reads them: the bridge, the database leg and the measures. */
@Injectable()
export class FullMigrationViewService {
  constructor(
    private readonly migrations: FullMigrationService,
    private readonly dbViews: DbMigrationViewService,
    @InjectRepository(DbMigrationEntity)
    private readonly dbMigRepo: Repository<DbMigrationEntity>,
    @InjectRepository(AppMigrationEntity)
    private readonly appMigRepo: Repository<AppMigrationEntity>,
  ) {}

  async getView(id: string): Promise<FullMigrationReadView> {
    return (await this.enrich([await this.migrations.getView(id)]))[0];
  }

  async listViews(userId: string): Promise<FullMigrationReadView[]> {
    return this.enrich(await this.migrations.listViews(userId));
  }

  private async enrich(
    rows: FullMigrationView[],
  ): Promise<FullMigrationReadView[]> {
    const dbIds = ids(rows.map((r) => r.dbMigrationId));
    const appIds = ids(rows.map((r) => r.appMigrationId));
    const dbLegs = dbIds.length
      ? await this.dbViews.views(
          await this.dbMigRepo.find({ where: { id: In(dbIds) } }),
        )
      : [];
    const appLegs = appIds.length
      ? await this.appMigRepo.find({ where: { id: In(appIds) } })
      : [];
    return rows.map((fm) =>
      fullMigrationReadView(
        fm,
        dbLegs.find((l) => l.id === fm.dbMigrationId) ?? null,
        appLegs.find((l) => l.id === fm.appMigrationId) ?? null,
      ),
    );
  }
}

function ids(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}
