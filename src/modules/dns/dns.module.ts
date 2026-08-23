import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { ConfigModule } from '@nestjs/config';
import { ProvidersModule } from '../providers/providers.module';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { ApplicationsModule } from '../applications/applications.module';
import { OidcModule } from '../oidc/oidc.module';
import { WsAuthModule } from '../auth/ws-auth.module';

import { DnsZoneEntity } from './entities/dns-zone.entity';
import { DnsZoneReplicaEntity } from './entities/dns-zone-replica.entity';
import { ClusterDnsZoneEntity } from './entities/cluster-dns-zone.entity';
import { AppEndpointEntity } from './entities/app-endpoint.entity';
import { WildcardCertificateEntity } from './entities/wildcard-certificate.entity';
import { SanCertificateEntity } from './entities/san-certificate.entity';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { ClusterAuthzInstallEntity } from '../authz/entities/cluster-authz-install.entity';
import { SandboxTenantEntity } from '../sandbox/entities/sandbox-tenant.entity';
import { IamModule } from '../iam/iam.module';
import { ClusterAuthzInstallRepository } from '../authz/repositories/cluster-authz-install.repository';

import { DnsZoneService } from './services/dns-zone.service';
import { ClusterDnsZoneService } from './services/cluster-dns-zone.service';
import { AppEndpointService } from './services/app-endpoint.service';
import { AppEndpointReconciliationService } from './services/app-endpoint-reconciliation.service';
import { AuthDomainSyncService } from './services/auth-domain-sync.service';
import { ApiDomainSyncService } from './services/api-domain-sync.service';
import { WebDomainSyncService } from './services/web-domain-sync.service';
import { WildcardCertificateService } from './services/wildcard-certificate.service';
import { WildcardCertificateConfigService } from './services/wildcard-certificate-config.service';
import {
  SanCertificateService,
  SAN_CERTIFICATE_QUEUE,
} from './services/san-certificate.service';
import { SanCertificateProcessor } from './processors/san-certificate.processor';
import { ReflectorInstallerService } from './services/reflector-installer.service';
import { SystemIngressService } from './services/system-ingress.service';
import { ClusterDnsCleanupService } from './services/cluster-dns-cleanup.service';
import { EndpointModeResolverService } from './services/endpoint-mode-resolver.service';
import { EndpointHostGuardService } from './services/endpoint-host-guard.service';
import { GatewayMiddlewareCompilerService } from './services/gateway-middleware-compiler.service';
import { DnsZoneReconciliationService } from './services/dns-zone-reconciliation.service';
import { DnsZoneReplicaService } from './services/dns-zone-replica.service';
import { DnsZoneReconciliationScheduler } from './schedulers/dns-zone-reconciliation.scheduler';

import { DnsZoneController } from './controllers/dns-zone.controller';
import { DnsZoneReplicaController } from './controllers/dns-zone-replica.controller';
import { ClusterDnsZoneController } from './controllers/cluster-dns-zone.controller';
import { AppEndpointController } from './controllers/app-endpoint.controller';
import { SanCertificateController } from './controllers/san-certificate.controller';
import { ClusterDnsGateway } from './gateway/cluster-dns.gateway';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      DnsZoneEntity,
      DnsZoneReplicaEntity,
      ClusterDnsZoneEntity,
      AppEndpointEntity,
      WildcardCertificateEntity,
      SanCertificateEntity,
      ClusterEntity,
      ApplicationEntity,
      ClusterAuthzInstallEntity,
      SandboxTenantEntity,
    ]),
    BullModule.registerQueue({ name: SAN_CERTIFICATE_QUEUE }),
    ProvidersModule,
    SharedInfrastructureModule,
    EncryptionModule,
    forwardRef(() => ApplicationsModule),
    OidcModule,
    WsAuthModule,
    IamModule,
  ],
  providers: [
    DnsZoneService,
    ClusterDnsZoneService,
    AppEndpointService,
    AppEndpointReconciliationService,
    AuthDomainSyncService,
    ApiDomainSyncService,
    WebDomainSyncService,
    WildcardCertificateService,
    WildcardCertificateConfigService,
    SanCertificateService,
    SanCertificateProcessor,
    ReflectorInstallerService,
    SystemIngressService,
    ClusterDnsGateway,
    ClusterAuthzInstallRepository,
    ClusterDnsCleanupService,
    EndpointModeResolverService,
    EndpointHostGuardService,
    GatewayMiddlewareCompilerService,
    DnsZoneReconciliationService,
    DnsZoneReplicaService,
    DnsZoneReconciliationScheduler,
  ],
  controllers: [
    DnsZoneController,
    DnsZoneReplicaController,
    ClusterDnsZoneController,
    AppEndpointController,
    SanCertificateController,
  ],
  exports: [
    DnsZoneService,
    ClusterDnsZoneService,
    AppEndpointService,
    AppEndpointReconciliationService,
    WildcardCertificateService,
    WildcardCertificateConfigService,
    SanCertificateService,
    SystemIngressService,
    ClusterDnsGateway,
    ClusterDnsCleanupService,
    EndpointModeResolverService,
    EndpointHostGuardService,
    GatewayMiddlewareCompilerService,
  ],
})
export class DnsModule {}
