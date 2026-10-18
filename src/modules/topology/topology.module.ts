import { Module } from '@nestjs/common';
import { ClusterFirewallEntity } from '../infrastructure/firewalls/entities/cluster-firewall.entity';
import { ProjectEntity } from '../projects/entities/project.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { ClusterNodeEntity } from '../infrastructure/clusters/entities/cluster-node.entity';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { TopologyController } from './controllers/topology.controller';
import { TopologyService } from './services/topology.service';
import { TopologyEventsService } from './services/topology-events.service';
import { TopologyScopeService } from './services/topology-scope.service';
import { ApplicationsModule } from '../applications/applications.module';
import { IamModule } from '../iam/iam.module';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { CatalogInstallEntity } from '../catalog/entities/catalog-install.entity';
import { WireGuardPeerEntity } from '../infrastructure/networking/entities/wireguard-peer.entity';
import { ApplicationServiceEntity } from '../attached-services/entities/application-service.entity';
import { AppEndpointEntity } from '../dns/entities/app-endpoint.entity';
import { ObservabilityModule } from '../observability/observability.module';
import { TopologyRecordsService } from './services/topology-records.service';
import { TopologyClusterReader } from './services/topology-cluster-reader.service';
import { TopologyLinksService } from './services/topology-links.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      ClusterEntity,
      ClusterNodeEntity,
      ApplicationEntity,
      CatalogInstallEntity,
      WireGuardPeerEntity,
      ApplicationServiceEntity,
      AppEndpointEntity,
      ClusterFirewallEntity,
      ProjectEntity,
    ]),
    ObservabilityModule,
    ApplicationsModule,
    IamModule,
    SharedInfrastructureModule,
    EncryptionModule,
  ],
  controllers: [TopologyController],
  providers: [
    TopologyService,
    TopologyEventsService,
    TopologyScopeService,
    TopologyLinksService,
    TopologyRecordsService,
    TopologyClusterReader,
  ],
  exports: [TopologyService, TopologyEventsService],
})
export class TopologyModule {}
