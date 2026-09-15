import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule } from '../../common/common.module';
import { KubernetesService } from './services/kubernetes.service';
import { LabelService } from './services/label.service';
import { ManagementAddressResolver } from './services/management-address.resolver';

@Module({
  imports: [ConfigModule, CommonModule],
  providers: [KubernetesService, LabelService, ManagementAddressResolver],
  exports: [
    CommonModule,
    KubernetesService,
    LabelService,
    ManagementAddressResolver,
  ],
})
export class SharedInfrastructureModule {}
