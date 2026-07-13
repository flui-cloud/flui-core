import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { StartupHealthCheckService } from './startup-health-check.service';
import { HealthController } from './health.controller';
import { VersionController } from './version.controller';
import { AuthModule } from '../../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ClusterEntity]),
    ConfigModule,
    AuthModule,
  ],
  controllers: [HealthController, VersionController],
  providers: [StartupHealthCheckService],
  exports: [StartupHealthCheckService],
})
export class HealthModule {}
