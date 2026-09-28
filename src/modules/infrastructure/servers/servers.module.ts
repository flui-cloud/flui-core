import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServersController } from './servers.controller';
import { ServersService } from './services/servers.service';
import { ServerEntity } from './entities/server.entity';
import { InfrastructureOperationEntity } from './entities/infrastructure-operations.entity';
import { InstancesModule } from 'src/modules/instances/instances.moduel';
import { AccessModule } from 'src/modules/access/access.module';
import { InfrastructureQueueProcessor } from './processors/infrastructure-queue.processor';
import { BullModule } from '@nestjs/bull';
import { SharedInfrastructureModule } from '../shared/shared-infrastructure.module';
import { InfrastructureOperationsModule } from '../operations/infrastructure-operations.module';
import { IamModule } from '../../iam/iam.module';

@Module({
  imports: [
    InstancesModule,
    AccessModule,
    SharedInfrastructureModule,
    InfrastructureOperationsModule,
    IamModule,
    TypeOrmModule.forFeature([ServerEntity, InfrastructureOperationEntity]),
    BullModule.registerQueue({
      name: 'infrastructure',
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    }),
  ],
  controllers: [ServersController],
  providers: [ServersService, InfrastructureQueueProcessor],
  exports: [
    ServersService,
    TypeOrmModule, // Re-export for InfrastructureOperationEntity access
  ],
})
export class ServersModule {}
