import { Global, Module } from '@nestjs/common';
import { SchedulerLeadershipService } from './scheduler-leadership.service';
import { SharedNumbersService } from '../../../common/shared-numbers/shared-numbers.service';

@Global()
@Module({
  providers: [SchedulerLeadershipService, SharedNumbersService],
  exports: [SchedulerLeadershipService, SharedNumbersService],
})
export class LeadershipModule {}
