import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { AppEndpointEntity } from '../dns/entities/app-endpoint.entity';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { AuditModule } from '../audit/audit.module';
import { IdentityConsoleStateEntity } from './entities/identity-console-state.entity';
import { IdentityConsoleService } from './services/identity-console.service';
import { IdentityConsoleScheduler } from './schedulers/identity-console.scheduler';
import { IdentityConsoleController } from './controllers/identity-console.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      IdentityConsoleStateEntity,
      ClusterEntity,
      ApplicationEntity,
      AppEndpointEntity,
    ]),
    SharedInfrastructureModule,
    EncryptionModule,
    AuditModule,
  ],
  controllers: [IdentityConsoleController],
  providers: [IdentityConsoleService, IdentityConsoleScheduler],
  exports: [IdentityConsoleService],
})
export class IdentityConsoleModule {}
