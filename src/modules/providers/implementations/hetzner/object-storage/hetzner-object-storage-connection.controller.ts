import { Body, Controller, Post, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { HetznerObjectStorageConnectionService } from './hetzner-object-storage-connection.service';
import { RequireSection } from '../../../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../../../iam/decorators/require-permission.decorator';
import { DataDoor } from '../../../../iam/decorators/data-door.decorator';
import { IAM_PERMISSION } from '../../../../iam/constants/iam-permissions';
import { SECTION } from '../../../../iam/constants/iam-sections';

export class ConnectHetznerObjectStorageDto {
  @IsString()
  accessKey: string;

  @IsString()
  secretKey: string;

  @IsOptional()
  @IsString()
  region?: string;
}

@ApiTags('Provider Connections')
@ApiBearerAuth()
@Controller('management/providers/hetzner/object-storage')
@RequireSection(SECTION.PROVIDERS)
export class HetznerObjectStorageConnectionController {
  constructor(
    private readonly service: HetznerObjectStorageConnectionService,
  ) {}

  @Post('connect')
  @DataDoor()
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  async connect(@Body() dto: ConnectHetznerObjectStorageDto) {
    return this.service.connect(dto);
  }

  @Get('status')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  async status() {
    const creds = await this.service.loadCreds();
    return { connected: !!creds, region: creds?.region };
  }
}
