import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RepositoriesModule } from '../repositories/repositories.module';
import { ManagementModule } from '../management/management.module';
import { GithubUserTokenEntity } from '../repositories/entities/github-user-token.entity';
import { CredentialsStatusService } from './services/credentials-status.service';
import { CredentialsController } from './controllers/credentials.controller';
import { GhcrPatVerificationScheduler } from './schedulers/ghcr-pat-verification.scheduler';
import { FluiRegistryModule } from '../flui-registry/flui-registry.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([GithubUserTokenEntity]),
    RepositoriesModule,
    ManagementModule,
    FluiRegistryModule,
  ],
  controllers: [CredentialsController],
  providers: [CredentialsStatusService, GhcrPatVerificationScheduler],
  exports: [CredentialsStatusService],
})
export class CredentialsModule {}
