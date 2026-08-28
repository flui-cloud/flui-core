import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProvidersModule } from '../../providers/providers.module';
import { EncryptionModule } from '../../shared/encryption/encryption.module';
import { SharedInfrastructureModule } from '../shared/shared-infrastructure.module';
import { ClustersModule } from '../clusters/clusters.module';
import { ClusterEntity } from '../clusters/entities/cluster.entity';
import { ClusterNodeEntity } from '../clusters/entities/cluster-node.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { InfrastructureOperationEntity } from '../servers/entities/infrastructure-operations.entity';
import { UnschedulablePodsService } from '../clusters/services/unschedulable-pods.service';
import { ScalingGroupEntity } from './entities/scaling-group.entity';
import { ScalingDecisionEntity } from './entities/scaling-decision.entity';
import { ScalingController } from './scaling.controller';
import { ScalingGroupService } from './services/scaling-group.service';
import { ScalingOverviewService } from './services/scaling-overview.service';
import { CATALOGUE_HTTP, FetchCatalogueHttp } from './catalogue/catalogue-http';
import { VopsCatalogueClient } from './catalogue/vops-catalogue.client';
import { AvailabilityCatalogueService } from './catalogue/availability-catalogue.service';
import { ShapeOrderingService } from './catalogue/shape-ordering.service';
import { ShapeFactsService } from './engine/shape-facts.service';
import { ScalingEngineService } from './engine/scaling-engine.service';
import { ScalingReconcilerService } from './engine/scaling-reconciler.service';
import { ScalingReconcilerScheduler } from './engine/scaling-reconciler.scheduler';
import { ScalingActuatorService } from './engine/scaling-actuator.service';
import { DrainFeasibilityService } from './engine/drain-feasibility.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ScalingGroupEntity,
      ScalingDecisionEntity,
      ClusterEntity,
      // Read-only: the fleet's shapes and prices, without a module dependency
      // on the cluster orchestration that writes them.
      ClusterNodeEntity,
      // Read-only: which applications keep their data on a given machine, and
      // whether a purchase is already on its way.
      ApplicationEntity,
      InfrastructureOperationEntity,
    ]),
    forwardRef(() => ClustersModule),
    ProvidersModule,
    SharedInfrastructureModule,
    EncryptionModule,
  ],
  controllers: [ScalingController],
  providers: [
    ScalingGroupService,
    ScalingOverviewService,
    { provide: CATALOGUE_HTTP, useClass: FetchCatalogueHttp },
    VopsCatalogueClient,
    AvailabilityCatalogueService,
    ShapeOrderingService,
    ShapeFactsService,
    // Declared here rather than imported from the cluster module: it holds no
    // state, and reaching for the whole orchestration to read pending pods
    // would tie the decision loop to everything that acts.
    UnschedulablePodsService,
    DrainFeasibilityService,
    ScalingEngineService,
    ScalingActuatorService,
    ScalingReconcilerService,
    ScalingReconcilerScheduler,
  ],
  exports: [
    ScalingGroupService,
    ScalingOverviewService,
    AvailabilityCatalogueService,
    ShapeOrderingService,
    ScalingEngineService,
    ScalingActuatorService,
  ],
})
export class ScalingModule {}
