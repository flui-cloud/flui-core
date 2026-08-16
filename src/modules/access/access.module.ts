import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { AccessController } from './access.controller';
import { AccessService } from './services/access.service';
import { SSHKeyGeneratorService } from './services/ssh-key-generator.service';
import { DefaultAccessRepository } from './repositories/default-access.repository';
import { SSHKeyEntity } from './entities/ssh-key.entity';
import { KeyStorageService } from './services/key-storage.service';
import { SecretRotationService } from './services/secret-rotation.service';
import { BearerTokenService } from './services/bearerToken.service';
import { HttpModule } from '@nestjs/axios';
import { ProviderCredentialsRepository } from './repositories/provider-credentials.repository';
import { ProviderCredentialsEntity } from './entities/credentials.entity';
import { JwtService } from '@nestjs/jwt';
import { ApiTokenRepository } from './repositories/api-token.repository';
import { ApiTokenEntity } from './entities/api-token.entity';
import { SSHProviderFactory } from './providers/ssh-provider.factory';
import { ContaboSSHProviderService } from './providers/contabo-ssh-provider.service';
import { HetznerSSHProviderService } from './providers/hetzner-ssh-provider.service';
import { ProvidersModule } from '../providers';
import { CommonModule } from '../common/common.module';
import { CAKeypairEntity } from './entities/ca-keypair.entity';
import { CAManagerService } from './services/ca-manager.service';
import { CertificateSignerService } from './services/certificate-signer.service';
import { CAController } from './controllers/ca.controller';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';

const accessRepositoryProvider = {
  provide: 'IAccessRepository',
  useClass: DefaultAccessRepository,
};

const providerCredentialsRepositoryProvider = {
  provide: 'IProviderCredentialsRepository',
  useClass: ProviderCredentialsRepository,
};
const apiTokenRepositoryProvider = {
  provide: 'IApiTokenRepository',
  useClass: ApiTokenRepository,
};
@Module({
  imports: [
    ConfigModule,
    HttpModule,
    forwardRef(() => ProvidersModule),
    CommonModule,
    TypeOrmModule.forFeature([
      SSHKeyEntity,
      ProviderCredentialsEntity,
      ApiTokenEntity,
      CAKeypairEntity,
      ClusterEntity,
    ]),
  ],
  controllers: [AccessController, CAController],
  providers: [
    AccessService,
    SSHKeyGeneratorService,
    accessRepositoryProvider,
    providerCredentialsRepositoryProvider,
    apiTokenRepositoryProvider,
    KeyStorageService,
    SecretRotationService,
    BearerTokenService,
    ProviderCredentialsRepository,
    ApiTokenRepository,
    JwtService,
    SSHProviderFactory,
    HetznerSSHProviderService,
    ContaboSSHProviderService,
    CAManagerService,
    CertificateSignerService,
  ],
  exports: [
    AccessService,
    CAManagerService,
    CertificateSignerService,
    SSHKeyGeneratorService,
    KeyStorageService,
  ],
})
export class AccessModule {}
