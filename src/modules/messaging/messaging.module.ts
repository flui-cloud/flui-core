import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { AlertEventEntity } from '../observability/entities/alert-event.entity';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { ClusterNatsEntity } from './entities/cluster-nats.entity';
import { NatsAccountEntity } from './entities/nats-account.entity';
import { ClusterNatsService } from './services/cluster-nats.service';
import { NatsAccountsController } from './controllers/nats-accounts.controller';
import { AppMessagingController } from './controllers/app-messaging.controller';
import { AppMessagingService } from './services/app-messaging.service';
import { AppQueuesService } from './services/app-queues.service';
import { NatsConnectionService } from './services/nats-connection.service';
import { QueueAlarmService } from './services/queue-alarm.service';
import { KubePortForwardService } from '../database-console/services/kube-port-forward.service';
import { ApplicationsModule } from '../applications/applications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ClusterNatsEntity,
      NatsAccountEntity,
      ClusterEntity,
      ApplicationEntity,
      AlertEventEntity,
    ]),
    SharedInfrastructureModule,
    EncryptionModule,
    ApplicationsModule,
  ],
  controllers: [NatsAccountsController, AppMessagingController],
  providers: [
    ClusterNatsService,
    AppMessagingService,
    AppQueuesService,
    NatsConnectionService,
    QueueAlarmService,
    KubePortForwardService,
  ],
  exports: [ClusterNatsService, AppMessagingService],
})
export class MessagingModule {}
