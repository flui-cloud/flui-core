import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { InfrastructureOperationEntity } from '../infrastructure/servers/entities/infrastructure-operations.entity';
import { ApplicationsModule } from '../applications/applications.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { DbLifecycleModule } from '../db-lifecycle/db-lifecycle.module';
import { DbMigrationEntity } from '../db-lifecycle/entities/db-migration.entity';
import { AppMigrationModule } from '../app-migration/app-migration.module';
import { AppMigrationEntity } from '../app-migration/entities/app-migration.entity';
import { FullMigrationEntity } from './entities/full-migration.entity';
import { FullMigrationService } from './services/full-migration.service';
import { DbConnectionRewireService } from './services/db-connection-rewire.service';
import { FullMigrationOpsService } from './services/full-migration-ops.service';
import { FullMigrationProcessor } from './processors/full-migration.processor';
import { FullMigrationController } from './controllers/full-migration.controller';
import { FULL_MIGRATION_QUEUE } from './full-migration.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      FullMigrationEntity,
      DbMigrationEntity,
      AppMigrationEntity,
      ClusterEntity,
      InfrastructureOperationEntity,
    ]),
    BullModule.registerQueue({ name: FULL_MIGRATION_QUEUE }),
    ApplicationsModule,
    EncryptionModule,
    DbLifecycleModule,
    AppMigrationModule,
  ],
  controllers: [FullMigrationController],
  providers: [
    FullMigrationService,
    DbConnectionRewireService,
    FullMigrationOpsService,
    FullMigrationProcessor,
  ],
  exports: [FullMigrationService, DbConnectionRewireService],
})
export class FullMigrationModule {}
