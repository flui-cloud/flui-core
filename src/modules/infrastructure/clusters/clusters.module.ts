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
import { BackupsModule } from 'src/modules/backups/backups.module';
import { ClusterRebuildService } from './services/cluster-rebuild.service';
import { ClusterRebuildProcessor } from './processors/cluster-rebuild.processor';
import { AppEndpointEntity } from 'src/modules/dns/entities/app-endpoint.entity';
import { CatalogInstallEntity } from 'src/modules/catalog/entities/catalog-install.entity';
import { BackupPolicyEntity } from 'src/modules/backups/entities/backup-policy.entity';
import { ApplicationsModule } from 'src/modules/applications/applications.module';

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
import { OrphanedClaimsService } from './services/orphaned-claims.service';
import { ClusterOrphanedClaimsController } from './cluster-orphaned-claims.controller';
import { ClusterCapacityService } from './services/cluster-capacity.service';
import { ClusterNodeScalingService } from './services/cluster-node-scaling.service';
import { OrphanVolumesService } from './services/orphan-volumes.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { InfrastructureOperationsModule } from '../operations/infrastructure-operations.module';

// Processors
import { ClusterQueueProcessor } from './processors/cluster-queue.processor';
import { AutoscaleActuationService } from './services/autoscale-actuation.service';
import { AutoscaleReconcilerRegistry } from './services/autoscale-reconciler.registry';
import { ScalingGroupEntity } from '../scaling/entities/scaling-group.entity';
import { ScalingDecisionEntity } from '../scaling/entities/scaling-decision.entity';
import { NodePriceService } from './services/node-price.service';
import { NodeShapeBackfillService } from './services/node-shape-backfill.service';
import { UnschedulablePodsService } from './services/unschedulable-pods.service';
import { FleetHistoryService } from './services/fleet-history.service';

@Module({
  imports: [
    ConfigModule,
    // Both behind forwardRef: applications and backups already reach back
    // here, and a rebuild needs the deploy path and the artifacts at once.
    forwardRef(() => ApplicationsModule),
    forwardRef(() => BackupsModule),

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
      // Swept when a cluster is deleted: neither carries a foreign key, so
      // nothing removes them on its own.
      ScalingGroupEntity,
      ScalingDecisionEntity,
      ClusterEntity,
      ClusterNodeEntity,
      // A rebuild re-points these with the applications: an endpoint left on
      // the lost cluster names a cluster that no longer answers.
      AppEndpointEntity,
      NodeBillableIntervalEntity,
      VolumeBillableIntervalEntity,
      InfrastructureOperationEntity,
      // Re-pointed by a cluster rebuild: both name a cluster that must not stay
      // the lost one, or the install and its schedule keep addressing it.
      CatalogInstallEntity,
      BackupPolicyEntity,
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
  controllers: [ClustersController, ClusterOrphanedClaimsController],
  providers: [
    ClusterRebuildService,
    ClusterRebuildProcessor,
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
    AutoscaleReconcilerRegistry,
    AutoscaleActuationService,
    NodePriceService,
    NodeShapeBackfillService,
    UnschedulablePodsService,
    FleetHistoryService,
    ClusterVNetService,
    ClusterScalingService,
    ClusterStorageService,
    OrphanedClaimsService,
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
    AutoscaleReconcilerRegistry,
    // Exported for the scaling actuator, the one caller outside this module
    // allowed to add or remove a node without a person asking for it.
    ClusterScalingService,
    ClusterMapperService, // Export for use in ControlClusterModule
    ClusterBillingService, // Export for use in BackupsModule (BillingEstimatorService)
    BillingIntervalsService,
    NodePriceService,
    NodeShapeBackfillService,
  ],
})
export class ClustersModule {}
