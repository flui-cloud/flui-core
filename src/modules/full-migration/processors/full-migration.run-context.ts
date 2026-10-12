import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationMaterializerService } from '../../applications/services/application-materializer.service';
import { DbMigrationEntity } from '../../db-lifecycle/entities/db-migration.entity';
import { DbMigrationService } from '../../db-lifecycle/services/db-migration.service';
import { DbReplicationService } from '../../db-lifecycle/services/db-replication.service';
import { DbPoolerCutService } from '../../db-lifecycle/services/db-pooler-cut.service';
import { AppMigrationEntity } from '../../app-migration/entities/app-migration.entity';
import { AppMigrationService } from '../../app-migration/services/app-migration.service';
import { FullMigrationEntity } from '../entities/full-migration.entity';
import { DbConnectionRewireService } from '../services/db-connection-rewire.service';
import { FullMigrationOpsService } from '../services/full-migration-ops.service';

/** What the full-migration processor shares with the parts of its state machine. */
export interface FullMigrationRunContext {
  fmRepo: Repository<FullMigrationEntity>;
  dbMigRepo: Repository<DbMigrationEntity>;
  appMigRepo: Repository<AppMigrationEntity>;
  appsRepo: ApplicationsRepository;
  dbMig: DbMigrationService;
  repl: DbReplicationService;
  appMig: AppMigrationService;
  materializer: ApplicationMaterializerService;
  rewire: DbConnectionRewireService;
  ops: FullMigrationOpsService;
  poolerCut?: DbPoolerCutService;
  logger: Logger;
}
