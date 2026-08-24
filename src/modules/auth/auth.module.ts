import { MailModule } from '../mail/mail.module';
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { resolveJwtSecret } from './utils/jwt-secret.util';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalJwtStrategy } from './strategies/local-jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { AuthController } from './controllers/auth.controller';
import { ApiKeysController } from './controllers/api-keys.controller';
import { UserEntity } from './entities/user.entity';
import { RefreshTokenEntity } from './entities/refresh-token.entity';
import { ApiKeyEntity } from './entities/api-key.entity';
import { LocalAuthService } from './services/local-auth.service';
import { OidcProfileSyncService } from './services/oidc-profile-sync.service';
import { ApiKeyService } from './services/api-key.service';
import { ApiKeyStrategy } from './strategies/api-key.strategy';
import { OidcModule } from '../oidc/oidc.module';
import { OidcIdentityBranding } from '../oidc/services/oidc-identity-branding.service';
import { OidcIdentityDirectory } from '../oidc/services/oidc-identity-directory.service';
import { OidcBootstrapService } from './services/oidc-bootstrap.service';
import { AgentIdentityService } from './services/agent-identity.service';
import { AgentIdentitiesController } from './controllers/agent-identities.controller';
import { PROVIDER_ADMIN_CONTEXT } from './interfaces/provider-admin-context';
import {
  OidcBootstrapProcessor,
  OIDC_BOOTSTRAP_QUEUE,
} from './processors/oidc-bootstrap.processor';
import { OidcBootstrapSeeder } from './seeders/oidc-bootstrap.seeder';
import { LocalIdentityDirectory } from './services/local-identity-directory.service';
import { LocalIdentityBranding } from './services/local-identity-branding.service';
import { UserManagementService } from './services/user-management.service';
import { UserManagementController } from './controllers/user-management.controller';
import { BrandingController } from './controllers/branding.controller';
import { IDENTITY_DIRECTORY } from './interfaces/identity-directory.interface';
import { IDENTITY_BRANDING } from './interfaces/identity-branding.interface';
import { AdminSeeder } from './seeders/admin.seeder';
import { BootstrapSeeder } from './seeders/bootstrap.seeder';
import { ConfigureAuthModeService } from '../dns/services/configure-auth-mode.service';
import { IamModule } from '../iam/iam.module';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { ClusterNodeEntity } from '../infrastructure/clusters/entities/cluster-node.entity';
import { NodeBillableIntervalEntity } from '../infrastructure/clusters/entities/node-billable-interval.entity';
import { VolumeBillableIntervalEntity } from '../infrastructure/clusters/entities/volume-billable-interval.entity';
import { BillingIntervalsService } from '../infrastructure/clusters/services/billing-intervals.service';
import { ApiTokenEntity } from '../access/entities/api-token.entity';
import { ProviderConfigurationEntity } from '../management/entities/provider-configuration.entity';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { FirewallEntity } from '../infrastructure/firewalls/entities/firewall.entity';
import { VNetEntity } from '../infrastructure/vnets/entities/vnet.entity';
import { VNetSubnetEntity } from '../infrastructure/vnets/entities/vnet-subnet.entity';
import { IamGroupEntity } from '../iam/entities/iam-group.entity';
import { IamRoleBindingEntity } from '../iam/entities/iam-role-binding.entity';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { ApplicationsModule } from '../applications/applications.module';
import { AccessModule } from '../access/access.module';
import { FirewallsModule } from '../infrastructure/firewalls/firewalls.module';

@Module({
  imports: [
    ConfigModule,
    MailModule,
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: resolveJwtSecret(config),
        signOptions: { expiresIn: '15m', algorithm: 'HS256' },
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([
      UserEntity,
      RefreshTokenEntity,
      ApiKeyEntity,
      ClusterEntity,
      ClusterNodeEntity,
      NodeBillableIntervalEntity,
      VolumeBillableIntervalEntity,
      ApiTokenEntity,
      ProviderConfigurationEntity,
      ApplicationEntity,
      FirewallEntity,
      VNetEntity,
      VNetSubnetEntity,
      IamRoleBindingEntity,
      IamGroupEntity,
    ]),
    SharedInfrastructureModule,
    EncryptionModule,
    ApplicationsModule,
    AccessModule,
    FirewallsModule,
    BullModule.registerQueue({ name: OIDC_BOOTSTRAP_QUEUE }),
    OidcModule,
    IamModule,
  ],
  providers: [
    JwtStrategy,
    LocalJwtStrategy,
    ApiKeyStrategy,
    ApiKeyService,
    JwtAuthGuard,
    AdminGuard,
    LocalAuthService,
    OidcProfileSyncService,
    AdminSeeder,
    BootstrapSeeder,
    BillingIntervalsService,
    ConfigureAuthModeService,
    OidcBootstrapService,
    { provide: PROVIDER_ADMIN_CONTEXT, useExisting: OidcBootstrapService },
    AgentIdentityService,
    OidcBootstrapProcessor,
    OidcBootstrapSeeder,
    LocalIdentityDirectory,
    LocalIdentityBranding,
    UserManagementService,
    {
      provide: IDENTITY_DIRECTORY,
      useFactory: (
        oidcImpl: OidcIdentityDirectory,
        localImpl: LocalIdentityDirectory,
      ) => (process.env.AUTH_MODE === 'local' ? localImpl : oidcImpl),
      inject: [OidcIdentityDirectory, LocalIdentityDirectory],
    },
    {
      provide: IDENTITY_BRANDING,
      useFactory: (
        oidcImpl: OidcIdentityBranding,
        localImpl: LocalIdentityBranding,
      ) => (process.env.AUTH_MODE === 'local' ? localImpl : oidcImpl),
      inject: [OidcIdentityBranding, LocalIdentityBranding],
    },
  ],
  controllers: [
    AuthController,
    ApiKeysController,
    AgentIdentitiesController,
    UserManagementController,
    BrandingController,
  ],
  exports: [
    PassportModule,
    JwtAuthGuard,
    AdminGuard,
    ApiKeyService,
    ApiKeyStrategy,
    OidcBootstrapService,
    AgentIdentityService,
    IDENTITY_DIRECTORY,
    // Exported for the sandbox reaper, which takes a person apart too and now
    // shares this service's binding cleanup instead of writing its own.
    UserManagementService,
  ],
})
export class AuthModule {}
