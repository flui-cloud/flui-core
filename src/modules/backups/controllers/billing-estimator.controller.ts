import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  BillingEstimatorService,
  EstimateProfile,
} from '../services/billing-estimator.service';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';
import { RequireSection } from '../../iam/decorators/require-section.decorator';

@ApiTags('Billing')
@ApiBearerAuth()
@Controller('billing')
@RequireSection('backup')
export class BillingEstimatorController {
  constructor(private readonly service: BillingEstimatorService) {}

  @Get('cluster/:id/estimate')
  async estimate(
    @Param('id') clusterId: string,
    @Query('profile') profile: EstimateProfile = 'single',
    @Query('primaryProvider')
    primaryProvider: StorageBackendProvider = StorageBackendProvider.SCALEWAY_OBJECT_STORAGE,
    @Query('replicaProvider') replicaProvider?: StorageBackendProvider,
    @Query('primaryDestinationId') primaryDestinationId?: string,
    @Query('replicaDestinationId') replicaDestinationId?: string,
  ) {
    const cluster = await this.service.estimateClusterMonthlyCost(clusterId);
    const backup = await this.service.estimateBackupMonthlyCost(
      clusterId,
      profile,
      primaryProvider,
      replicaProvider,
      primaryDestinationId,
      replicaDestinationId,
    );
    const total =
      cluster.clusterMonthlyCents !== null && backup.totalCentsPerMonth !== null
        ? cluster.clusterMonthlyCents + backup.totalCentsPerMonth
        : null;
    return {
      cluster,
      backup,
      total,
      currency: 'EUR',
      disclaimer: cluster.disclaimer,
    };
  }
}
