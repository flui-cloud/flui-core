import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { InfrastructureOperationEntity } from '../infrastructure/servers/entities/infrastructure-operations.entity';
import { BackupPolicyEntity } from '../backups/entities/backup-policy.entity';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { DbLifecycleModule } from '../db-lifecycle/db-lifecycle.module';
import { ApplicationsModule } from '../applications/applications.module';
import { ClusterHaModule } from '../cluster-ha/cluster-ha.module';
import { CnpgOperatorInstallerService } from './services/cnpg-operator-installer.service';
import { PostgresHaService } from './services/postgres-ha.service';
import { PostgresHaPortsAdapter } from './services/postgres-ha-ports.adapter';
import { PostgresHaProcessor } from './processors/postgres-ha.processor';
import { PrimaryPlacementService } from './services/primary-placement.service';
import { PrimaryPlacementScheduler } from './schedulers/primary-placement.scheduler';
import { PostgresHaController } from './controllers/postgres-ha.controller';
import { POSTGRES_HA_QUEUE } from './postgres-ha.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ApplicationEntity,
      ClusterEntity,
      InfrastructureOperationEntity,
      BackupPolicyEntity,
    ]),
    BullModule.registerQueue({ name: POSTGRES_HA_QUEUE }),
    SharedInfrastructureModule,
    EncryptionModule,
    DbLifecycleModule,
    ApplicationsModule,
    ClusterHaModule,
  ],
  controllers: [PostgresHaController],
  providers: [
    CnpgOperatorInstallerService,
    PostgresHaService,
    PostgresHaPortsAdapter,
    PostgresHaProcessor,
    PrimaryPlacementService,
    PrimaryPlacementScheduler,
  ],
  exports: [CnpgOperatorInstallerService, PostgresHaService],
})
export class PostgresHaModule {}
