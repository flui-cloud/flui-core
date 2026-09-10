import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogModule } from '../catalog/catalog.module';
import { ApplicationsModule } from '../applications/applications.module';
import { ATTACHED_SERVICES_PORT } from '../applications/interfaces/attached-services.port';
import { UserEntity } from '../auth/entities/user.entity';
import { ApplicationServiceEntity } from './entities/application-service.entity';
import { ApplicationServicesRepository } from './repositories/application-services.repository';
import { AttachedServicesResolverService } from './services/attached-services-resolver.service';

/**
 * Above both, so neither has to import the other.
 *
 * `CatalogModule` already imports `ApplicationsModule`, so an application that
 * provisions a catalog block cannot do it from either side without a cycle.
 * This module sits on top, nobody imports it, and the deploy path reaches it
 * through `ATTACHED_SERVICES_PORT` — a token declared under `applications/`
 * that names no catalog type.
 *
 * Global because of that: the token has to be resolvable from
 * `ApplicationsModule`'s injector, which cannot import this one.
 */
@Global()
@Module({
  imports: [
    // `UserEntity` is bound at TypeORM level, not by importing AuthModule: the
    // only thing needed from it is the owner's email, which is what places an
    // attached block in the same namespace as the application that reads it.
    TypeOrmModule.forFeature([ApplicationServiceEntity, UserEntity]),
    CatalogModule,
    ApplicationsModule,
  ],
  providers: [
    ApplicationServicesRepository,
    AttachedServicesResolverService,
    {
      provide: ATTACHED_SERVICES_PORT,
      useExisting: AttachedServicesResolverService,
    },
  ],
  exports: [
    ATTACHED_SERVICES_PORT,
    AttachedServicesResolverService,
    ApplicationServicesRepository,
  ],
})
export class AttachedServicesModule {}
