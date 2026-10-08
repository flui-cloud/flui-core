import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectEntity } from './entities/project.entity';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { ProjectSpacesService } from './project-spaces.service';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ProjectEntity, ApplicationEntity, ClusterEntity]),
    SharedInfrastructureModule,
    EncryptionModule,
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectSpacesService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
