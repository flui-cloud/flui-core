import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WireGuardPeerEntity } from './entities/wireguard-peer.entity';
import { VNetEntity } from '../vnets/entities/vnet.entity';
import { WireGuardPeerService } from './services/wireguard-peer.service';
import { WireGuardReconciler } from './services/wireguard-reconciler.service';
import { WireGuardReconciliationScheduler } from './schedulers/wireguard-reconciliation.scheduler';
import { ClusterEntity } from '../clusters/entities/cluster.entity';
import { InfrastructureOperationEntity } from '../servers/entities/infrastructure-operations.entity';
import { ProvidersModule } from '../../providers/providers.module';

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
      InfrastructureOperationEntity,
    ]),
    // Enrolling an existing cluster restarts K3s on its master: minutes long,
    // and its failure belongs in an operation record rather than in whoever
    // was holding the request.
    BullModule.registerQueue({ name: 'infrastructure' }),
    // For HostCommandService: the overlay reaches a node the same way the host
    // firewall does, rather than growing an SSH path of its own.
    ProvidersModule,
  ],
  providers: [
    WireGuardPeerService,
    WireGuardReconciler,
    WireGuardReconciliationScheduler,
  ],
  exports: [WireGuardPeerService, WireGuardReconciler],
})
export class NetworkingModule {}
