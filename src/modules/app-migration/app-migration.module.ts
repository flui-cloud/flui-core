import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { ApplicationsModule } from '../applications/applications.module';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { InfrastructureOperationEntity } from '../infrastructure/servers/entities/infrastructure-operations.entity';
import { AppEndpointEntity } from '../dns/entities/app-endpoint.entity';
import { DnsModule } from '../dns/dns.module';
import { AppMigrationEntity } from './entities/app-migration.entity';
import { AppMigrationService } from './services/app-migration.service';
import { AppMigrationProcessor } from './processors/app-migration.processor';
import { AppMigrationController } from './controllers/app-migration.controller';
import { APP_MIGRATION_QUEUE } from './app-migration.constants';
import { AppVolumeTransferService } from './services/app-volume-transfer.service';
import { BackupPolicyEntity } from '../backups/entities/backup-policy.entity';
import { BackupDestinationEntity } from '../backups/entities/backup-destination.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AppMigrationEntity,
      ApplicationEntity,
      ClusterEntity,
      AppEndpointEntity,
      InfrastructureOperationEntity,
      BackupPolicyEntity,
      BackupDestinationEntity,
    ]),
    BullModule.registerQueue({ name: APP_MIGRATION_QUEUE }),
    ApplicationsModule,
    DnsModule,
  ],
  controllers: [AppMigrationController],
  providers: [
    AppMigrationService,
    AppMigrationProcessor,
    AppVolumeTransferService,
  ],
  exports: [AppMigrationService, AppVolumeTransferService],
})
export class AppMigrationModule {}
