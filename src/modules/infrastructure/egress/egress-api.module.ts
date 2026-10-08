import { Module, forwardRef } from '@nestjs/common';
import { ApplicationsModule } from '../../applications/applications.module';
import { EgressModule } from './egress.module';
import {
  AppEgressController,
  ClusterEgressController,
} from './egress.controller';

@Module({
  imports: [EgressModule, forwardRef(() => ApplicationsModule)],
  controllers: [ClusterEgressController, AppEgressController],
})
export class EgressApiModule {}
