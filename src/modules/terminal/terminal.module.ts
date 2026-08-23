import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TerminalGateway } from './gateways/terminal.gateway';
import { TerminalService } from './services/terminal.service';
import { TerminalFeatureConfig } from './terminal-feature.config';
import { TerminalConnectionManager } from './services/terminal-connection-manager.service';
import { NativeSSHConnectionService } from './services/native-ssh-connection.service';
import { TerminalTargetResolver } from './services/terminal-target.resolver';
import { AccessModule } from '../access/access.module';
import { WsAuthModule } from '../auth/ws-auth.module';
import { IamModule } from '../iam/iam.module';
import { ClusterNodeEntity } from '../infrastructure/clusters/entities/cluster-node.entity';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { ServerEntity } from '../infrastructure/servers/entities/server.entity';

@Module({
  imports: [
    AccessModule, // For CertificateSignerService
    WsAuthModule,
    IamModule,
    TypeOrmModule.forFeature([ClusterNodeEntity, ClusterEntity, ServerEntity]),
  ],
  providers: [
    TerminalFeatureConfig,
    TerminalGateway,
    TerminalService,
    TerminalConnectionManager,
    NativeSSHConnectionService,
    TerminalTargetResolver,
  ],
  exports: [TerminalService, NativeSSHConnectionService],
})
export class TerminalModule {}
