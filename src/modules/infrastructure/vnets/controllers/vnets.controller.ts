import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { VNetsService } from '../services/vnets.service';
import { CreateVNetDto, VNetResponseDto, VNetListResponseDto } from '../dto';
import { AddSubnetDto } from '../dto/add-subnet.dto';
import { RequireSection } from '../../../iam/decorators/require-section.decorator';

@ApiTags('VNets')
@ApiBearerAuth()
@Controller('vnets')
@RequireSection('infrastructure')
export class VNetsController {
  constructor(private readonly vnetsService: VNetsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new Virtual Network (VNet)' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'VNet created successfully',
    type: VNetResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid input or provider does not support VNets',
  })
  async createVNet(
    @Body() createVNetDto: CreateVNetDto,
  ): Promise<VNetResponseDto> {
    return this.vnetsService.createVNet(createVNetDto);
  }

  @Post('import')
  @ApiOperation({ summary: 'Import an existing VNet from provider' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'VNet imported successfully',
    type: VNetResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid input or VNet not found on provider',
  })
  async importVNet(
    @Body()
    importDto: {
      providerResourceId: string;
      provider: string;
      name: string;
      ipRange: string;
      labels?: Array<{ key: string; value: string }>;
      metadata?: Record<string, any>;
    },
  ): Promise<VNetResponseDto> {
    return this.vnetsService.importVNet(importDto as any);
  }

  @Get()
  @ApiOperation({ summary: 'List all VNets' })
  @ApiQuery({
    name: 'provider',
    required: false,
    description: 'Filter by cloud provider',
  })
  @ApiQuery({
    name: 'clusterId',
    required: false,
    description: 'Filter by cluster ID',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of VNets',
    type: VNetListResponseDto,
  })
  async listVNets(
    @Query('provider') provider?: string,
    @Query('clusterId') clusterId?: string,
  ): Promise<VNetListResponseDto> {
    return this.vnetsService.listVNets({ provider, clusterId });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get VNet by ID' })
  @ApiParam({
    name: 'id',
    description: 'VNet ID (UUID)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'VNet details',
    type: VNetResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'VNet not found',
  })
  async getVNet(@Param('id') id: string): Promise<VNetResponseDto> {
    return this.vnetsService.getVNet(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a VNet' })
  @ApiParam({
    name: 'id',
    description: 'VNet ID (UUID)',
  })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'VNet deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'VNet not found',
  })
  async deleteVNet(@Param('id') id: string): Promise<void> {
    await this.vnetsService.deleteVNet(id);
  }

  @Post(':id/sync')
  @ApiOperation({ summary: 'Sync VNet details from cloud provider' })
  @ApiParam({
    name: 'id',
    description: 'VNet ID (UUID)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'VNet synced successfully',
    type: VNetResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'VNet not found',
  })
  async syncVNet(@Param('id') id: string): Promise<VNetResponseDto> {
    return this.vnetsService.syncVNet(id);
  }

  @Get('provider-resource/:providerResourceId')
  @ApiOperation({ summary: 'Get VNet by provider resource ID' })
  @ApiParam({
    name: 'providerResourceId',
    description: 'Provider-specific VNet ID',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'VNet details',
    type: VNetResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'VNet not found',
  })
  async getVNetByProviderResourceId(
    @Param('providerResourceId') providerResourceId: string,
  ): Promise<VNetResponseDto> {
    return this.vnetsService.getVNetByProviderResourceId(providerResourceId);
  }

  @Post(':id/subnets')
  @ApiOperation({ summary: 'Add a subnet to a VNet' })
  @ApiParam({
    name: 'id',
    description: 'VNet ID (UUID)',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Subnet added successfully',
    type: VNetResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'VNet not found',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Failed to add subnet or invalid IP range',
  })
  async addSubnet(
    @Param('id') id: string,
    @Body() addSubnetDto: AddSubnetDto,
  ): Promise<VNetResponseDto> {
    return this.vnetsService.addSubnetToVNet(id, addSubnetDto);
  }

  @Delete(':id/subnets/:subnetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a subnet from a VNet' })
  @ApiParam({
    name: 'id',
    description: 'VNet ID (UUID)',
  })
  @ApiParam({
    name: 'subnetId',
    description: 'Subnet provider resource ID',
  })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Subnet deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'VNet or subnet not found',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Failed to delete subnet',
  })
  async deleteSubnet(
    @Param('id') id: string,
    @Param('subnetId') subnetId: string,
  ): Promise<VNetResponseDto> {
    return this.vnetsService.deleteSubnetFromVNet(id, { subnetId });
  }
}
