import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FirewallEntity } from './entities/firewall.entity';
import { ClusterFirewallEntity } from './entities/cluster-firewall.entity';
import { ClusterEntity } from '../clusters/entities/cluster.entity';
import { FirewallsService } from './services/firewalls.service';
import { EncryptionModule } from 'src/modules/shared/encryption/encryption.module';
import { NetworkingModule } from '../networking/networking.module';
import { FirewallDesiredStateService } from './services/firewall-desired-state.service';
import { FirewallReconciliationService } from './services/firewall-reconciliation.service';
import { CrossProviderFirewallService } from './services/cross-provider-firewall.service';
import { FirewallReconciliationScheduler } from './schedulers/firewall-reconciliation.scheduler';
import { FirewallsController } from './controllers/firewalls.controller';
import { ClusterFirewallsController } from './controllers/cluster-firewalls.controller';
import { ProvidersModule } from '../../providers/providers.module';
import { SharedInfrastructureModule } from '../shared/shared-infrastructure.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      FirewallEntity,
      ClusterFirewallEntity,
      ClusterEntity,
    ]),
    ProvidersModule, // For FirewallProviderFactory and provider services
    SharedInfrastructureModule, // For LabelService
    // For WireGuardPeerService: the overlay's inbound rule is derived from the
    // peers themselves, not from a second list kept in step by hand.
    NetworkingModule,
    // For the stored kubeconfig: the one place the chosen path is written down.
    EncryptionModule,
  ],
  providers: [
    FirewallsService,
    FirewallDesiredStateService,
    FirewallReconciliationService,
    CrossProviderFirewallService,
    FirewallReconciliationScheduler,
  ],
  controllers: [FirewallsController, ClusterFirewallsController],
  exports: [
    FirewallsService,
    FirewallDesiredStateService,
    FirewallReconciliationService,
    CrossProviderFirewallService,
  ],
})
export class FirewallsModule {}
