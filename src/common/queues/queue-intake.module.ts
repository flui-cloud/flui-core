import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { QueueIntakeService } from './queue-intake.service';

@Module({
  imports: [DiscoveryModule],
  providers: [QueueIntakeService],
})
export class QueueIntakeModule {}
