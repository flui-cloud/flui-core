import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClusterEntity } from '../clusters/entities/cluster.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationsModule } from '../../applications/applications.module';
import { DeferredActionEntity } from './deferred-action.entity';
import { MaintenanceService } from './maintenance.service';
import {
  AppMaintenanceController,
  ClusterMaintenanceController,
} from './maintenance.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ClusterEntity,
      ApplicationEntity,
      DeferredActionEntity,
    ]),
    forwardRef(() => ApplicationsModule),
  ],
  controllers: [ClusterMaintenanceController, AppMaintenanceController],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
