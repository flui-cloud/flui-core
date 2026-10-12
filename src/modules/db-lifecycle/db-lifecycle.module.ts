import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { UserEntity } from '../auth/entities/user.entity';
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
import { NetworkingModule } from '../infrastructure/networking/networking.module';
import { DbWriteFenceService } from './services/db-write-fence.service';
import { DbPodPlacementService } from './services/db-pod-placement.service';
import { DbOverlayTransportService } from './services/db-overlay-transport.service';
import { DbPhysicalReplicationService } from './services/db-physical-replication.service';
import { DbCredentialHandoffService } from './services/db-credential-handoff.service';
import { DbMigrationRecoveryService } from './services/db-migration-recovery.service';
import { DbMigrationViewService } from './services/db-migration-view.service';
import { DbPoolerCutService } from './services/db-pooler-cut.service';
import { PoolerPauseSweeper } from './services/pooler-pause.sweeper';
import { WireGuardLinkEntity } from '../infrastructure/networking/entities/wireguard-link.entity';
import { FullMigrationEntity } from '../full-migration/entities/full-migration.entity';

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
      UserEntity,
      WireGuardLinkEntity,
      FullMigrationEntity,
    ]),
    BullModule.registerQueue({ name: DB_LIFECYCLE_QUEUE }),
    SharedInfrastructureModule,
    EncryptionModule,
    CatalogModule,
    BackupsModule,
    NetworkingModule,
  ],
  controllers: [DbLifecycleController, DbMigrationController],
  providers: [
    DbReplicationService,
    DbPodExecService,
    DbReplicationTransportService,
    DbReplicationStatusService,
    DbMigrationService,
    DbMigrationProcessor,
    DbWriteFenceService,
    DbPodPlacementService,
    DbOverlayTransportService,
    DbPhysicalReplicationService,
    DbCredentialHandoffService,
    DbMigrationRecoveryService,
    DbMigrationViewService,
    DbPoolerCutService,
    PoolerPauseSweeper,
  ],
  exports: [
    DbReplicationService,
    DbMigrationService,
    DbMigrationViewService,
    DbPoolerCutService,
  ],
})
export class DbLifecycleModule {}
