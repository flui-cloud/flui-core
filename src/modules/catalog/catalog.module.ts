import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { CatalogAppDefinitionEntity } from './entities/catalog-app-definition.entity';
import { CatalogInstallEntity } from './entities/catalog-install.entity';
import { InfrastructureOperationEntity } from '../infrastructure/servers/entities/infrastructure-operations.entity';
import { CatalogAppDefinitionRepository } from './repositories/catalog-app-definition.repository';
import { CatalogInstallRepository } from './repositories/catalog-install.repository';
import { CatalogService } from './services/catalog.service';
import { CatalogManifestLoaderService } from './services/catalog-manifest-loader.service';
import { CatalogSchemaValidatorService } from './services/catalog-schema-validator.service';
import { CatalogTemplateResolverService } from './services/catalog-template-resolver.service';
import { CatalogSecretGeneratorService } from './services/catalog-secret-generator.service';
import { CatalogSeederService } from './services/catalog-seeder.service';
import {
  CatalogInstallerService,
  CATALOG_INSTALL_QUEUE,
} from './services/catalog-installer.service';
import { CatalogDependencyResolverService } from './services/catalog-dependency-resolver.service';
import { CatalogLinkingService } from './services/catalog-linking.service';
import { RemovalPreviewService } from './services/removal-preview.service';
import { CatalogInstallProcessor } from './processors/catalog-install.processor';
import { CatalogController } from './controllers/catalog.controller';
import { AppRemovalController } from './controllers/app-removal.controller';
import { AppAccessGuard } from '../applications/guards/app-access.guard';
import { ApplicationsModule } from '../applications/applications.module';
import { DnsModule } from '../dns/dns.module';
import { OidcModule } from '../oidc/oidc.module';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { SandboxTenantEntity } from '../sandbox/entities/sandbox-tenant.entity';
import { ClustersModule } from '../infrastructure/clusters/clusters.module';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CatalogAppDefinitionEntity,
      CatalogInstallEntity,
      InfrastructureOperationEntity,
      ClusterEntity,
      SandboxTenantEntity,
    ]),
    BullModule.registerQueue({ name: CATALOG_INSTALL_QUEUE }),
    ApplicationsModule,
    DnsModule,
    OidcModule,
    SharedInfrastructureModule,
    EncryptionModule,
    forwardRef(() => ClustersModule),
  ],
  controllers: [CatalogController, AppRemovalController],
  providers: [
    CatalogAppDefinitionRepository,
    CatalogInstallRepository,
    CatalogService,
    CatalogManifestLoaderService,
    CatalogSchemaValidatorService,
    CatalogTemplateResolverService,
    CatalogSecretGeneratorService,
    CatalogSeederService,
    CatalogInstallerService,
    CatalogDependencyResolverService,
    CatalogLinkingService,
    RemovalPreviewService,
    CatalogInstallProcessor,
    // Instantiated in this module's injector because AppRemovalController mounts
    // it; its own dependencies come from the ApplicationsModule imported above.
    AppAccessGuard,
  ],
  exports: [
    CatalogInstallRepository,
    CatalogAppDefinitionRepository,
    CatalogService,
    CatalogInstallerService,
    CatalogDependencyResolverService,
    CatalogLinkingService,
  ],
})
export class CatalogModule {}
