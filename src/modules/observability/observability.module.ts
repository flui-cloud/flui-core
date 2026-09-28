import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

// Services
import { PrometheusQueryService } from './services/prometheus-query.service';
import { LokiQueryService } from './services/loki-query.service';
import { ClusterHealthService } from './services/cluster-health.service';
import { ApplicationMetricsService } from './services/application-metrics.service';
import { ApplicationTrafficService } from './services/application-traffic.service';
import { AlertEventsService } from './services/alert-events.service';

// Schedulers
import { AlertMaintenanceScheduler } from './schedulers/alert-maintenance.scheduler';

// Controllers
import { ObservabilityController } from './controllers/observability.controller';
import { ServerMetricsController } from './controllers/server-metrics.controller';
import { ClusterHealthController } from './controllers/cluster-health.controller';
import { ApplicationMetricsController } from './controllers/application-metrics.controller';
import { ApplicationTrafficController } from './controllers/application-traffic.controller';
import { ApplicationLogsController } from './controllers/application-logs.controller';
import { AlertEventsController } from './controllers/alert-events.controller';

// Entities needed for Prometheus Service Discovery
import { ServerEntity } from '../infrastructure/servers/entities/server.entity';
import { ClusterNodeEntity } from '../infrastructure/clusters/entities/cluster-node.entity';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { AlertEventEntity } from './entities/alert-event.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { MailModule } from '../mail/mail.module';
import { AlertMailService } from './services/alert-mail.service';
import { AlertRoutingService } from './services/alert-routing.service';
import { AlertDestinationsService } from './services/alert-destinations.service';
import { AlertDestinationsController } from './controllers/alert-destinations.controller';
import { AlertDestinationEntity } from './entities/alert-destination.entity';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { IamModule } from '../iam/iam.module';

// External modules
import { ApplicationsModule } from '../applications/applications.module';

/**
 * Observability Module
 *
 * Provides centralized metrics collection and log aggregation for clusters.
 *
 * Features:
 * - Prometheus HTTP Service Discovery: Queries DB to discover servers to monitor
 * - PromQL queries for metrics by cluster_id: Direct queries to Prometheus (no DB)
 * - LogQL queries for logs via Loki by cluster_id: Direct queries to Loki (no DB)
 * - Unified API endpoints for metrics/logs queried by cluster_id with optional server_id filtering
 *
 * Architecture:
 * - Development: Docker Compose (Prometheus + Loki)
 * - Production: K3s-based observability cluster with centralized monitoring
 *
 * Database Usage:
 * - PrometheusQueryService: Queries Prometheus using cluster_id (matches DB UUID directly)
 * - LokiQueryService: Queries Loki using cluster_id (matches DB UUID directly)
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      ServerEntity,
      ClusterNodeEntity,
      ClusterEntity,
      AlertEventEntity,
      AlertDestinationEntity,
      UserEntity,
    ]),
    ApplicationsModule,
    MailModule,
    EncryptionModule,
    IamModule,
  ],
  controllers: [
    ObservabilityController,
    ServerMetricsController,
    ClusterHealthController,
    ApplicationMetricsController,
    ApplicationTrafficController,
    ApplicationLogsController,
    AlertEventsController,
    AlertDestinationsController,
  ],
  providers: [
    PrometheusQueryService,
    LokiQueryService,
    ClusterHealthService,
    ApplicationMetricsService,
    ApplicationTrafficService,
    AlertEventsService,
    AlertMailService,
    AlertRoutingService,
    AlertDestinationsService,
    AlertMaintenanceScheduler,
  ],
  exports: [
    PrometheusQueryService,
    LokiQueryService,
    ClusterHealthService,
    ApplicationMetricsService,
    ApplicationTrafficService,
    AlertEventsService,
    AlertMailService,
    AlertRoutingService,
  ],
})
export class ObservabilityModule {}
