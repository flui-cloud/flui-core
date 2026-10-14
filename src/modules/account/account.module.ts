import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { sharedThrottlerStorage } from '../../common/throttling/redis-throttler.storage';
import { UserEntity } from '../auth/entities/user.entity';
import { IamModule } from '../iam/iam.module';
import { OidcAccountClient } from '../oidc/services/oidc-account.client';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';

@Module({
  imports: [
    HttpModule.register({ timeout: 10000 }),
    TypeOrmModule.forFeature([UserEntity]),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: 100 }],
      storage: sharedThrottlerStorage(),
    }),
    IamModule,
  ],
  controllers: [AccountController],
  providers: [OidcAccountClient, AccountService],
})
export class AccountModule {}
