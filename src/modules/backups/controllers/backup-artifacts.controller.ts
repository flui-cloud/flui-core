import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import { RequireSection } from '../../iam/decorators/require-section.decorator';

/**
 * One read surface over the ledger, covering every engine: a cluster snapshot,
 * a database's continuous backups and a single volume's copies are the same
 * kind of row and belong in the same list.
 */
@ApiTags('Backups')
@ApiBearerAuth()
@Controller('backup-artifacts')
@RequireSection('backup')
export class BackupArtifactsController {
  constructor(private readonly artifacts: BackupArtifactRepository) {}

  @Get()
  @ApiOperation({
    summary: 'List backup artifacts for one application or one cluster',
  })
  async list(
    @Query('applicationId') applicationId?: string,
    @Query('clusterId') clusterId?: string,
  ): Promise<BackupArtifactEntity[]> {
    if (applicationId) {
      return this.artifacts.listForApplication(applicationId);
    }
    if (clusterId) {
      return this.artifacts.listForCluster(clusterId);
    }
    return [];
  }
}
