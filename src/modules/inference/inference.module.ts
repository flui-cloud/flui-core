import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccessModule } from '../access/access.module';
import { ManagementModule } from '../management/management.module';
import { ProvidersModule } from '../providers/providers.module';
import { IamModule } from '../iam/iam.module';
import { InferenceConnectionEntity } from './entities/inference-connection.entity';
import { InferenceConnectionRepository } from './repositories/inference-connection.repository';
import { InferenceClientService } from './services/inference-client.service';
import { InferenceResolverService } from './services/inference-resolver.service';
import { InferenceProviderService } from './services/inference-provider.service';
import { InferenceConnectionService } from './services/inference-connection.service';
import { InferenceController } from './controllers/inference.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([InferenceConnectionEntity]),
    AccessModule,
    ManagementModule,
    ProvidersModule,
    // For the one question the list asks and the spend path deliberately does
    // not: who, besides the owner, may *see* a personal connection.
    IamModule,
  ],
  controllers: [InferenceController],
  providers: [
    InferenceConnectionRepository,
    InferenceClientService,
    InferenceResolverService,
    InferenceProviderService,
    InferenceConnectionService,
  ],
  exports: [InferenceResolverService, InferenceClientService],
})
export class InferenceModule {}
