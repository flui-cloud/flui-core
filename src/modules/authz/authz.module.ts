import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { ApplicationsModule } from '../applications/applications.module';
import { AuthModule } from '../auth/auth.module';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { InfrastructureOperationEntity } from '../infrastructure/servers/entities/infrastructure-operations.entity';
import { AppEndpointEntity } from '../dns/entities/app-endpoint.entity';
import { IamModule } from '../iam/iam.module';
import { ClusterAuthzInstallEntity } from './entities/cluster-authz-install.entity';
import { ClusterAuthzInstallRepository } from './repositories/cluster-authz-install.repository';
import { AuthzController } from './controllers/authz.controller';
import { AuthzInstallController } from './controllers/authz-install.controller';
import { InternalAppAuthzService } from './services/internal-app-authz.service';
import { GatewayAuthzService } from './services/gateway-authz.service';
import { InternalAppAuditService } from './services/internal-app-audit.service';
import {
  AuthzInstallService,
  AUTHZ_INSTALL_QUEUE,
} from './services/authz-install.service';
import { AuthzInstallProcessor } from './processors/authz-install.processor';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ClusterAuthzInstallEntity,
      ClusterEntity,
      InfrastructureOperationEntity,
      AppEndpointEntity,
    ]),
    BullModule.registerQueue({ name: AUTHZ_INSTALL_QUEUE }),
    ApplicationsModule,
    AuthModule,
    SharedInfrastructureModule,
    EncryptionModule,
    IamModule,
  ],
  controllers: [AuthzController, AuthzInstallController],
  providers: [
    InternalAppAuthzService,
    GatewayAuthzService,
    InternalAppAuditService,
    ClusterAuthzInstallRepository,
    AuthzInstallService,
    AuthzInstallProcessor,
  ],
  exports: [InternalAppAuditService, ClusterAuthzInstallRepository],
})
export class AuthzModule {}
