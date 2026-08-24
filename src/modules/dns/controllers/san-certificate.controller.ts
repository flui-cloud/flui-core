import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SanCertificateService } from '../services/san-certificate.service';
import { CreateSanCertificateDto } from '../dto/create-san-certificate.dto';
import { SanCertificateResponseDto } from '../dto/san-certificate-response.dto';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

@ApiTags('SAN Certificates')
@ApiBearerAuth()
@Controller()
export class SanCertificateController {
  constructor(private readonly service: SanCertificateService) {}

  @Post('clusters/:clusterId/san-certificates')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Create a SAN certificate covering up to 20 fqdns under a single cert. Returns immediately; reconciliation runs async.',
  })
  @ApiParam({ name: 'clusterId', format: 'uuid' })
  @ApiResponse({ status: 202, type: SanCertificateResponseDto })
  async create(
    @Param('clusterId', new ParseUUIDPipe()) clusterId: string,
    @Body() dto: CreateSanCertificateDto,
  ): Promise<SanCertificateResponseDto> {
    const entity = await this.service.create(clusterId, dto);
    return SanCertificateResponseDto.fromEntity(entity);
  }

  @Get('clusters/:clusterId/san-certificates')
  @ApiOperation({ summary: 'List SAN certificates for a cluster' })
  @ApiParam({ name: 'clusterId', format: 'uuid' })
  @ApiResponse({ status: 200, type: [SanCertificateResponseDto] })
  async listByCluster(
    @Param('clusterId', new ParseUUIDPipe()) clusterId: string,
  ): Promise<SanCertificateResponseDto[]> {
    const entities = await this.service.listByCluster(clusterId);
    return entities.map(SanCertificateResponseDto.fromEntity);
  }

  @Get('san-certificates/:id')
  @ApiOperation({ summary: 'Get a SAN certificate by id' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, type: SanCertificateResponseDto })
  async getById(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SanCertificateResponseDto> {
    const entity = await this.service.getById(id);
    return SanCertificateResponseDto.fromEntity(entity);
  }

  @Delete('san-certificates/:id')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete a SAN certificate. Fails with 409 if any endpoint is still bound to it.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  async delete(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.service.delete(id);
  }
}
