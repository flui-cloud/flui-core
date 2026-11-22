import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApplicationsModule } from '../applications/applications.module';
import { DnsModule } from '../dns/dns.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { AppIdentityLinkEntity } from './entities/app-identity-link.entity';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { AppIdentityService } from './services/app-identity.service';
import { IdentityPoolResolver } from './services/identity-pool.resolver';
import { AppIdentityController } from './controllers/app-identity.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([AppIdentityLinkEntity, ApplicationEntity]),
    ApplicationsModule,
    DnsModule,
    EncryptionModule,
  ],
  controllers: [AppIdentityController],
  providers: [AppIdentityService, IdentityPoolResolver],
  exports: [AppIdentityService, IdentityPoolResolver],
})
export class AppIdentityModule {}
