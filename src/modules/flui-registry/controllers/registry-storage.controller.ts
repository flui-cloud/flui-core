import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import {
  ConnectRegistryStorageDto,
  RegistryBucketDto,
  RegistryBucketRemovalDto,
  ConnectScalewayRegistryStorageDto,
  RegistryStorageStatusDto,
} from '../dto/registry-storage.dto';
import {
  FLUI_REGISTRY_CONFIG,
  FluiRegistryConfig,
} from '../flui-registry.config';
import { ScalewayRegistryStorageProvisioner } from '../provisioners/scaleway-registry-storage.provisioner';
import { FluiRegistryDeploymentService } from '../services/flui-registry-deployment.service';
import { RegistryStorageService } from '../services/registry-storage.service';
import { RegistryUsageService } from '../services/registry-usage.service';

/**
 * Where the instance registry keeps images. The instance's own setting, like
 * its GitHub integration, so the same permission manages it.
 */
@ApiTags('Registry')
@ApiBearerAuth()
@RequirePermission(IAM_PERMISSION.INTEGRATION_MANAGE)
@Controller('registry/storage')
export class RegistryStorageController {
  constructor(
    @Inject(FLUI_REGISTRY_CONFIG) private readonly config: FluiRegistryConfig,
    private readonly storage: RegistryStorageService,
    private readonly scaleway: ScalewayRegistryStorageProvisioner,
    private readonly deployment: FluiRegistryDeploymentService,
    private readonly usage: RegistryUsageService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Where the instance registry keeps images, and the space they take',
  })
  @ApiQuery({
    name: 'measure',
    required: false,
    description:
      'Measure the space now instead of returning the last measurement',
  })
  async status(
    @Query('measure') measure?: string,
  ): Promise<RegistryStorageStatusDto> {
    const status: RegistryStorageStatusDto = {
      ...(await this.storage.status()),
      backend: this.config.storageBackend,
    };
    if (this.config.mode !== 'flui') return status;
    status.usage =
      measure === 'true'
        ? await this.usage.measure()
        : await this.usage.current();
    return status;
  }

  @Post('scaleway')
  @ApiOperation({
    summary:
      'Create a bucket for the registry on Scaleway, in a project of its own, with a key limited to Object Storage there',
  })
  async connectScaleway(
    @Body() dto: ConnectScalewayRegistryStorageDto,
  ): Promise<RegistryStorageStatusDto> {
    await this.storage.connect(await this.scaleway.provision(dto.region));
    return this.applied();
  }

  @Post()
  @ApiOperation({
    summary:
      'Connect a bucket of your own, with a credential that reaches only that bucket',
  })
  async connect(
    @Body() dto: ConnectRegistryStorageDto,
  ): Promise<RegistryStorageStatusDto> {
    await this.storage.connect(dto);
    return this.applied();
  }

  @Get('buckets')
  @ApiOperation({
    summary:
      'Every bucket the registry has been connected to, the one in use and the ones it replaced',
  })
  async buckets(): Promise<RegistryBucketDto[]> {
    return this.storage.list();
  }

  @Delete('buckets/:id')
  @ApiOperation({
    summary:
      'Remove a bucket the registry no longer uses. One Flui created is deleted with its images and its dedicated key; one of your own is only forgotten.',
  })
  async removeBucket(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RegistryBucketRemovalDto> {
    if (
      this.config.mode === 'flui' &&
      this.config.storageBackend === 's3' &&
      !(await this.deployment.settled())
    ) {
      throw new ConflictException(
        'The registry is still moving to its new bucket: some copies read the old one. Try again once they have restarted.',
      );
    }
    return this.storage.remove(id);
  }

  private async applied(): Promise<RegistryStorageStatusDto> {
    if (this.config.mode === 'flui' && this.config.storageBackend === 's3') {
      await this.deployment.reconcile();
    }
    return {
      ...(await this.storage.status()),
      backend: this.config.storageBackend,
    };
  }
}
