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

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AppMigrationEntity,
      ApplicationEntity,
      ClusterEntity,
      AppEndpointEntity,
      InfrastructureOperationEntity,
    ]),
    BullModule.registerQueue({ name: APP_MIGRATION_QUEUE }),
    ApplicationsModule,
    DnsModule,
  ],
  controllers: [AppMigrationController],
  providers: [AppMigrationService, AppMigrationProcessor],
  exports: [AppMigrationService],
})
export class AppMigrationModule {}
