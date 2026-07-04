import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { ClusterNodeEntity } from '../infrastructure/clusters/entities/cluster-node.entity';
import { InfrastructureOperationEntity } from '../infrastructure/servers/entities/infrastructure-operations.entity';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CatalogInstallEntity } from '../catalog/entities/catalog-install.entity';
import { BackupsModule } from '../backups/backups.module';
import { DbReplicationLinkEntity } from './entities/db-replication-link.entity';
import { DbMigrationEntity } from './entities/db-migration.entity';
import { DbReplicationService } from './services/db-replication.service';
import { DbPodExecService } from './services/db-pod-exec.service';
import { DbReplicationTransportService } from './services/db-replication-transport.service';
import { DbReplicationStatusService } from './services/db-replication-status.service';
import { DbMigrationService } from './services/db-migration.service';
import { DbMigrationProcessor } from './processors/db-migration.processor';
import { DbLifecycleController } from './controllers/db-lifecycle.controller';
import { DbMigrationController } from './controllers/db-migration.controller';
import { DB_LIFECYCLE_QUEUE } from './db-lifecycle.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DbReplicationLinkEntity,
      DbMigrationEntity,
      ApplicationEntity,
      ClusterEntity,
      ClusterNodeEntity,
      InfrastructureOperationEntity,
      CatalogInstallEntity,
    ]),
    BullModule.registerQueue({ name: DB_LIFECYCLE_QUEUE }),
    SharedInfrastructureModule,
    EncryptionModule,
    CatalogModule,
    BackupsModule,
  ],
  controllers: [DbLifecycleController, DbMigrationController],
  providers: [
    DbReplicationService,
    DbPodExecService,
    DbReplicationTransportService,
    DbReplicationStatusService,
    DbMigrationService,
    DbMigrationProcessor,
  ],
  exports: [DbReplicationService, DbMigrationService],
})
export class DbLifecycleModule {}
