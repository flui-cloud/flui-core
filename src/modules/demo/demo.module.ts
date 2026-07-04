import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { FullMigrationModule } from '../full-migration/full-migration.module';
import { DemoConfigEntity } from './entities/demo-config.entity';
import { DemoStateService } from './services/demo-state.service';
import { DemoEventsService } from './services/demo-events.service';
import { DemoProberService } from './services/demo-prober.service';
import { DemoOrchestratorService } from './services/demo-orchestrator.service';
import { DemoStatusService } from './services/demo-status.service';
import { DemoLoopScheduler } from './schedulers/demo-loop.scheduler';
import { DemoStatusController } from './controllers/demo-status.controller';
import { DemoAdminController } from './controllers/demo-admin.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DemoConfigEntity,
      ClusterEntity,
      ApplicationEntity,
    ]),
    FullMigrationModule,
  ],
  controllers: [DemoStatusController, DemoAdminController],
  providers: [
    DemoStateService,
    DemoEventsService,
    DemoProberService,
    DemoOrchestratorService,
    DemoStatusService,
    DemoLoopScheduler,
  ],
})
export class DemoModule {}
