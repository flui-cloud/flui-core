import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { ObservabilityModule } from '../observability/observability.module';
import { BackupsModule } from '../backups/backups.module';
import { CredentialsModule } from '../credentials/credentials.module';
import { ApplicationsModule } from '../applications/applications.module';
import { FleetController } from './controllers/fleet.controller';
import { FleetMetricsService } from './services/fleet-metrics.service';
import { FleetAttentionService } from './services/fleet-attention.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ClusterEntity]),
    ObservabilityModule,
    BackupsModule,
    CredentialsModule,
    ApplicationsModule,
  ],
  controllers: [FleetController],
  providers: [FleetMetricsService, FleetAttentionService],
})
export class FleetModule {}
