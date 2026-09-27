import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WireGuardPeerEntity } from './entities/wireguard-peer.entity';
import { VNetEntity } from '../vnets/entities/vnet.entity';
import { WireGuardPeerService } from './services/wireguard-peer.service';
import { WireGuardReconciler } from './services/wireguard-reconciler.service';
import { WireGuardHubService } from './services/wireguard-hub.service';
import { ApiServerSanService } from './services/api-server-san.service';
import { WireGuardReconciliationScheduler } from './schedulers/wireguard-reconciliation.scheduler';
import { ClusterEntity } from '../clusters/entities/cluster.entity';
import { ClusterNodeEntity } from '../clusters/entities/cluster-node.entity';
import { ManagementNetworkService } from './services/management-network.service';
import { FluiNetworkBellService } from './services/flui-network-bell.service';
import { UserEntity } from '../../auth/entities/user.entity';
import { ManagementNetworkController } from './controllers/management-network.controller';
import { InfrastructureOperationEntity } from '../servers/entities/infrastructure-operations.entity';
import { ProvidersModule } from '../../providers/providers.module';
import { SharedInfrastructureModule } from '../shared/shared-infrastructure.module';
import { VNetsModule } from '../vnets/vnets.module';
import { EncryptionModule } from '../../shared/encryption/encryption.module';

/**
 * The management overlay: who is on it, at which address, with which key.
 *
 * Holds no host access of its own. Applying a rendered config is the host
 * reconciler's job (`providers/core/host`), which keeps the decisions here
 * testable without a machine.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      WireGuardPeerEntity,
      VNetEntity,
      ClusterEntity,
      ClusterNodeEntity,
      UserEntity,
      InfrastructureOperationEntity,
    ]),
    // Enrolling an existing cluster restarts K3s on its master: minutes long,
    // and its failure belongs in an operation record rather than in whoever
    // was holding the request.
    BullModule.registerQueue({ name: 'infrastructure' }),
    // For HostCommandService: the overlay reaches a node the same way the host
    // firewall does, rather than growing an SSH path of its own.
    ProvidersModule,
    SharedInfrastructureModule,
    // The overlay is a network, and an operator looking for it looks in VNet
    // management. Nothing else here creates that row.
    VNetsModule,
    // The control's key is kept sealed, so a rebuilt control is the same peer.
    EncryptionModule,
  ],
  controllers: [ManagementNetworkController],
  providers: [
    ManagementNetworkService,
    FluiNetworkBellService,
    WireGuardPeerService,
    WireGuardHubService,
    WireGuardReconciler,
    WireGuardReconciliationScheduler,
    ApiServerSanService,
  ],
  exports: [
    ManagementNetworkService,
    WireGuardPeerService,
    WireGuardHubService,
    WireGuardReconciler,
    ApiServerSanService,
  ],
})
export class NetworkingModule {}
