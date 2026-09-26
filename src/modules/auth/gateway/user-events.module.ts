import { Module } from '@nestjs/common';
import { WsAuthModule } from '../ws-auth.module';
import { UserEventsGateway } from './user-events.gateway';

/** The `/user` gateway on its own, so any module can reach a person's bell without importing the one that first needed it. */
@Module({
  imports: [WsAuthModule],
  providers: [UserEventsGateway],
  exports: [UserEventsGateway],
})
export class UserEventsModule {}
