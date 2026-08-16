import { Module } from '@nestjs/common';
import { TerminalGateway } from './gateways/terminal.gateway';
import { TerminalService } from './services/terminal.service';
import { TerminalFeatureConfig } from './terminal-feature.config';
import { TerminalConnectionManager } from './services/terminal-connection-manager.service';
import { NativeSSHConnectionService } from './services/native-ssh-connection.service';
import { AccessModule } from '../access/access.module';
import { WsAuthModule } from '../auth/ws-auth.module';

@Module({
  imports: [
    AccessModule, // For CertificateSignerService
    WsAuthModule,
  ],
  providers: [
    TerminalFeatureConfig,
    TerminalGateway,
    TerminalService,
    TerminalConnectionManager,
    NativeSSHConnectionService,
  ],
  exports: [TerminalService, NativeSSHConnectionService],
})
export class TerminalModule {}
