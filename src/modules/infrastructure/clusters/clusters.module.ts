import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { ConfigModule } from '@nestjs/config';

// Import shared modules
import { ServersModule } from '../servers/servers.module';
import { ProvidersModule } from 'src/modules/providers/providers.module';
import { AccessModule } from 'src/modules/access/access.module';
import { SharedInfrastructureModule } from '../shared/shared-infrastructure.module';
import { ManagementModule } from 'src/modules/management/management.module';
import { FirewallsModule } from '../firewalls/firewalls.module';
import { VNetsModule } from '../vnets/vnets.module';
import { GrafanaModule } from 'src/modules/grafana/grafana.module';
import { ControlClusterModule } from '../control-cluster/control-cluster.module';
import { ImagesModule } from 'src/modules/images/images.module';
import { TerminalModule } from 'src/modules/terminal/terminal.module';
import { ObservabilityModule } from 'src/modules/observability/observability.module';
import { DnsModule } from 'src/modules/dns/dns.module';

// Entities
import { ClusterEntity } from './entities/cluster.entity';
import { ClusterNodeEntity } from './entities/cluster-node.entity';
import { NodeBillableIntervalEntity } from './entities/node-billable-interval.entity';
import { VolumeBillableIntervalEntity } from './entities/volume-billable-interval.entity';
import { InfrastructureOperationEntity } from '../servers/entities/infrastructure-operations.entity';
import { SSHKeyEntity } from 'src/modules/access/entities/ssh-key.entity';
import { VNetSubnetEntity } from '../vnets/entities/vnet-subnet.entity';

// Controllers
import { ClustersController } from './clusters.controller';

// Services
import { ClustersService } from './clusters.service';
import { ClusterValidationService } from './services/cluster-validation.service';
import { ClusterCreationService } from './services/cluster-creation.service';
import { ClusterDeletionService } from './services/cluster-deletion.service';
import { ClusterMapperService } from './services/cluster-mapper.service';
import { ClusterOperationsService } from './services/cluster-operations.service';
import { ClusterFirewallIntegrationService } from './services/cluster-firewall-integration.service';
import { ClusterOrchestrationService } from './services/cluster-orchestration.service';
import { ClusterPowerManagementService } from './services/cluster-power-management.service';
import { ClusterSshCleanupService } from './services/cluster-ssh-cleanup.service';
import { K3sScriptService } from './services/k3s-script.service';
import { ByosNodeJoinService } from './services/byos-node-join.service';
import { ByosNodeRemovalService } from './services/byos-node-removal.service';
import { ByosVNetService } from './services/byos-vnet.service';
import { EncryptionModule } from 'src/modules/shared/encryption/encryption.module';
import { ClusterBillingService } from './services/cluster-billing.service';
import { BillingIntervalsService } from './services/billing-intervals.service';
import { ClusterAutoscaleService } from './services/cluster-autoscale.service';
import { ClusterVNetService } from './services/cluster-vnet.service';
import { ClusterScalingService } from './services/cluster-scaling.service';
import { ClusterStorageService } from './services/cluster-storage.service';
import { ClusterCapacityService } from './services/cluster-capacity.service';
import { ClusterNodeScalingService } from './services/cluster-node-scaling.service';
import { OrphanVolumesService } from './services/orphan-volumes.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { InfrastructureOperationsModule } from '../operations/infrastructure-operations.module';

// Processors
import { ClusterQueueProcessor } from './processors/cluster-queue.processor';

@Module({
  imports: [
    ConfigModule,

    // Shared infrastructure modules
    ServersModule,
    ProvidersModule,
    AccessModule,
    SharedInfrastructureModule,
    ManagementModule,
    FirewallsModule,
    VNetsModule,
    GrafanaModule, // For GrafanaDatasourceService
    ImagesModule, // For ResourceProfilesService
    forwardRef(() => ControlClusterModule),
    TerminalModule, // For NativeSSHConnectionService (kubeconfig fetch)
    EncryptionModule,
    InfrastructureOperationsModule,
    ObservabilityModule,
    forwardRef(() => DnsModule),

    // Cluster entities
    TypeOrmModule.forFeature([
      ClusterEntity,
      ClusterNodeEntity,
      NodeBillableIntervalEntity,
      VolumeBillableIntervalEntity,
      InfrastructureOperationEntity,
      SSHKeyEntity, // For SSH key cleanup service
      VNetSubnetEntity,
      // Read-only access for node-lock check (no module dep on ApplicationsModule)
      ApplicationEntity,
    ]),

    // Shared queue for infrastructure operations
    BullModule.registerQueue({
      name: 'infrastructure',
    }),
  ],
  controllers: [ClustersController],
  providers: [
    // Main orchestrator service
    ClustersService,

    // Modular services
    ClusterValidationService,
    ClusterCreationService,
    ClusterDeletionService,
    ClusterOperationsService,
    ClusterMapperService,
    ClusterFirewallIntegrationService,
    ClusterOrchestrationService,
    ClusterPowerManagementService,
    ClusterSshCleanupService,
    ClusterBillingService,
    BillingIntervalsService,
    ClusterAutoscaleService,
    ClusterVNetService,
    ClusterScalingService,
    ClusterStorageService,
    ClusterCapacityService,
    ClusterNodeScalingService,
    OrphanVolumesService,
    K3sScriptService,
    ByosNodeJoinService,
    ByosNodeRemovalService,
    ByosVNetService,

    // Queue processor
    ClusterQueueProcessor,
  ],
  exports: [
    ClustersService,
    ClusterMapperService, // Export for use in ControlClusterModule
    ClusterBillingService, // Export for use in BackupsModule (BillingEstimatorService)
    BillingIntervalsService,
  ],
})
export class ClustersModule {}
