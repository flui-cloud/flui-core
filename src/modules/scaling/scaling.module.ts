import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { CrashDiagnosisEntity } from './entities/crash-diagnosis.entity';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { ApplicationsModule } from '../applications/applications.module';
import { CrashDiagnosesRepository } from './repositories/crash-diagnoses.repository';
import { CrashPatternMatcherService } from './services/crash-pattern-matcher.service';
import { DiagnosticEngineService } from './services/diagnostic-engine.service';
import { DeploymentGuardService } from './services/deployment-guard.service';
import { CrashRecoveryService } from './services/crash-recovery.service';
import { EndpointDiagnosisService } from './services/endpoint-diagnosis.service';
import { PodDebugService } from './services/pod-debug.service';
import { PodDebugController } from './controllers/pod-debug.controller';
import { CrashDiagnosesController } from './controllers/crash-diagnoses.controller';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      CrashDiagnosisEntity,
      ApplicationEntity,
      ClusterEntity,
    ]),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    SharedInfrastructureModule,
    EncryptionModule,
    forwardRef(() => ApplicationsModule),
  ],
  controllers: [PodDebugController, CrashDiagnosesController],
  providers: [
    CrashDiagnosesRepository,
    CrashPatternMatcherService,
    DiagnosticEngineService,
    DeploymentGuardService,
    CrashRecoveryService,
    EndpointDiagnosisService,
    PodDebugService,
  ],
  exports: [
    DeploymentGuardService,
    CrashRecoveryService,
    EndpointDiagnosisService,
    PodDebugService,
  ],
})
export class ScalingModule {}
