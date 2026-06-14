import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OidcProviderAdminClient } from './services/oidc-provider-admin.service';
import { OidcIdentityBranding } from './services/oidc-identity-branding.service';
import { OidcIdentityDirectory } from './services/oidc-identity-directory.service';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { UserEntity } from '../auth/entities/user.entity';

@Module({
  imports: [
    HttpModule.register({ timeout: 10000 }),
    ConfigModule,
    TypeOrmModule.forFeature([ClusterEntity, UserEntity]),
  ],
  providers: [
    OidcProviderAdminClient,
    OidcIdentityBranding,
    OidcIdentityDirectory,
  ],
  exports: [
    OidcProviderAdminClient,
    OidcIdentityBranding,
    OidcIdentityDirectory,
  ],
})
export class OidcModule {}
