import { Module } from '@nestjs/common';
import { ServersModule } from './servers/servers.module';
import { ClustersModule } from './clusters/clusters.module';
import { InfrastructureOperationsModule } from './operations/infrastructure-operations.module';
import { ControlClusterModule } from './control-cluster/control-cluster.module';
import { VNetsModule } from './vnets/vnets.module';
import { NetworkingModule } from './networking/networking.module';
import { PlatformComponentsModule } from './platform-components/platform-components.module';
import { ScalingModule } from './scaling/scaling.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule,
    InfrastructureOperationsModule,
    ServersModule,
    ClustersModule,
    ControlClusterModule,
    VNetsModule,
    NetworkingModule,
    PlatformComponentsModule,
    ScalingModule,
    // FirewallsModule (future)
  ],
  exports: [
    InfrastructureOperationsModule,
    ServersModule,
    ClustersModule,
    ControlClusterModule,
    VNetsModule,
    NetworkingModule,
    PlatformComponentsModule,
    ScalingModule,
  ],
})
export class InfrastructureModule {}
