import { Body, Controller, Post, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { HetznerObjectStorageConnectionService } from './hetzner-object-storage-connection.service';
import { RequireSection } from '../../../../iam/decorators/require-section.decorator';

@RequireSection('providers')
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
export class HetznerObjectStorageConnectionController {
  constructor(
    private readonly service: HetznerObjectStorageConnectionService,
  ) {}

  @Post('connect')
  async connect(@Body() dto: ConnectHetznerObjectStorageDto) {
    return this.service.connect(dto);
  }

  @Get('status')
  async status() {
    const creds = await this.service.loadCreds();
    return { connected: !!creds, region: creds?.region };
  }
}
