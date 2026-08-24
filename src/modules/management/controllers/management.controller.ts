import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  Res,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Public } from '../../auth/decorators/public.decorator';
import { ManagementService } from '../services/management.service';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { ProviderDefinition } from '../entities/provider-definition.entity';
import { ProviderConfigurationDto } from '../dto/provider-configuration.dto';
import { ConfigureProviderDto } from '../dto/configure-provider.dto';
import { ProviderFiltersDto } from '../dto/provider-filters.dto';
import { ValidationResultDto } from '../dto/validation-result.dto';
import { HealthStatusDto } from '../dto/health-status.dto';
import { ProviderDefinitionDto } from '../dto/provider-definition.dto';
import { ProviderCredentialsDto } from '../dto/credentials.dto';
import { EnableProviderDto } from '../dto/enable-provider.dto';
import { UpdateProviderRegionsDto } from '../dto/update-regions.dto';
import { UpdateCredentialsExpiryDto } from '../dto/update-credentials-expiry.dto';
import { NodeSizeOptionDto } from '../dto/node-size-option.dto';
import { PricingQueryDto } from '../dto/pricing-query.dto';
import { PricingResponseDto } from '../dto/pricing-response.dto';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

@ApiTags('Provider Management')
@Controller('management')
@ApiBearerAuth()
@RequireSection('providers')
export class ManagementController {
  constructor(private readonly managementService: ManagementService) {}

  @Get('providers')
  @ApiOperation({ summary: 'Get all available providers' })
  @ApiResponse({
    status: 200,
    description: 'List of available providers',
    type: [ProviderDefinitionDto],
  })
  async getAvailableProviders(): Promise<ProviderDefinition[]> {
    return this.managementService.getAvailableProviders();
  }

  @Get('providers/:provider')
  @ApiOperation({ summary: 'Get provider details' })
  @ApiParam({ name: 'provider', enum: CloudProvider })
  @ApiResponse({
    status: 200,
    description: 'Provider details',
    type: ProviderDefinitionDto,
  })
  @ApiResponse({ status: 404, description: 'Provider not found' })
  async getProvider(
    @Param('provider') provider: CloudProvider,
  ): Promise<ProviderDefinition> {
    return this.managementService.getProvider(provider);
  }

  @Get('providers/:provider/logo')
  @Public()
  @ApiOperation({ summary: 'Get provider logo image' })
  @ApiParam({ name: 'provider', enum: CloudProvider })
  @ApiResponse({
    status: 200,
    description: 'Provider logo image (SVG, PNG or JPG)',
  })
  @ApiResponse({ status: 404, description: 'Provider not found' })
  async getProviderLogo(
    @Param('provider') provider: CloudProvider,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const { data, contentType } =
        this.managementService.getProviderLogo(provider);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(data);
    } catch {
      throw new NotFoundException(`Logo for provider ${provider} not found`);
    }
  }

  @Get('configurations')
  @ApiOperation({ summary: 'Get user provider configurations' })
  @ApiQuery({ name: 'provider', enum: CloudProvider, required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'isActive', type: Boolean, required: false })
  @ApiResponse({
    status: 200,
    description: 'List of user provider configurations',
    type: [ProviderConfigurationDto],
  })
  async getUserProviderConfigurations(
    @Query() filters: ProviderFiltersDto,
  ): Promise<ProviderConfigurationDto[]> {
    return this.managementService.getUserProviderConfigurations(filters);
  }

  @Get('configurations/:provider')
  @ApiOperation({ summary: 'Get specific provider configuration' })
  @ApiParam({ name: 'provider', enum: CloudProvider })
  @ApiResponse({
    status: 200,
    description: 'Provider configuration',
    type: ProviderConfigurationDto,
  })
  @ApiResponse({ status: 404, description: 'Configuration not found' })
  async getProviderConfiguration(
    @Param('provider') provider: CloudProvider,
  ): Promise<ProviderConfigurationDto> {
    return this.managementService.getProviderConfiguration(provider);
  }

  @Post('providers/:provider/configure')
  @ApiOperation({ summary: 'Configure a new provider' })
  @ApiParam({ name: 'provider', enum: CloudProvider })
  @ApiResponse({
    status: 201,
    description: 'Provider configured successfully',
    type: ProviderConfigurationDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid configuration' })
  @ApiResponse({ status: 409, description: 'Provider already configured' })
  async configureProvider(
    @Param('provider') provider: CloudProvider,
    @Body() configDto: ConfigureProviderDto,
  ): Promise<ProviderConfigurationDto> {
    configDto.provider = provider;
    return this.managementService.configureProvider(configDto);
  }

  @Post('providers/:provider/validate')
  @ApiOperation({ summary: 'Validate provider credentials' })
  @ApiParam({ name: 'provider', enum: CloudProvider })
  @ApiResponse({
    status: 200,
    description: 'Validation result',
    type: ValidationResultDto,
  })
  @ApiResponse({ status: 404, description: 'Provider not found' })
  @HttpCode(HttpStatus.OK)
  async validateProvider(
    @Param('provider') provider: CloudProvider,
    @Body() credentials: ProviderCredentialsDto,
  ): Promise<ValidationResultDto> {
    return this.managementService.validateProvider(provider, credentials);
  }

  @Put('providers/:provider/enable')
  @ApiOperation({ summary: 'Enable or disable a provider' })
  @ApiParam({ name: 'provider', enum: CloudProvider })
  @ApiResponse({
    status: 200,
    description: 'Provider status updated',
    type: ProviderConfigurationDto,
  })
  @ApiResponse({ status: 404, description: 'Provider not configured' })
  async enableProvider(
    @Param('provider') provider: CloudProvider,
    @Body() enableDto: EnableProviderDto,
  ): Promise<ProviderConfigurationDto> {
    return this.managementService.enableProvider(provider, enableDto.enabled);
  }

  @Put('providers/:provider/credentials')
  @ApiOperation({
    summary:
      'Rotate or replace the credentials of an already configured provider',
  })
  @ApiParam({ name: 'provider', enum: CloudProvider })
  @ApiResponse({
    status: 200,
    description: 'Credentials rotated successfully',
    type: ProviderConfigurationDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid credentials' })
  @ApiResponse({ status: 404, description: 'Provider not configured' })
  async rotateProviderCredentials(
    @Param('provider') provider: CloudProvider,
    @Body() credentials: ProviderCredentialsDto,
  ): Promise<ProviderConfigurationDto> {
    credentials.provider = provider;
    return this.managementService.rotateProviderCredentials(
      provider,
      credentials,
    );
  }

  @Patch('providers/:provider/credentials/expiry')
  @ApiOperation({
    summary:
      'Update the expiry of the active credential without rotating its value',
  })
  @ApiParam({ name: 'provider', enum: CloudProvider })
  @ApiResponse({
    status: 200,
    description: 'Expiry updated successfully',
    type: ProviderConfigurationDto,
  })
  @ApiResponse({ status: 404, description: 'Provider not configured' })
  async updateProviderCredentialsExpiry(
    @Param('provider') provider: CloudProvider,
    @Body() dto: UpdateCredentialsExpiryDto,
  ): Promise<ProviderConfigurationDto> {
    return this.managementService.updateProviderCredentialsExpiry(
      provider,
      dto.expiresAt ? new Date(dto.expiresAt) : null,
    );
  }

  @Put('providers/:provider/regions')
  @ApiOperation({ summary: 'Update enabled regions for a configured provider' })
  @ApiParam({ name: 'provider', enum: CloudProvider })
  @ApiResponse({
    status: 200,
    description: 'Enabled regions updated',
    type: ProviderConfigurationDto,
  })
  @ApiResponse({ status: 400, description: 'Region not supported' })
  @ApiResponse({ status: 404, description: 'Provider not configured' })
  async updateProviderRegions(
    @Param('provider') provider: CloudProvider,
    @Body() dto: UpdateProviderRegionsDto,
  ): Promise<ProviderConfigurationDto> {
    return this.managementService.updateProviderRegions(
      provider,
      dto.enabledRegions,
    );
  }

  @Get('providers/:provider/regions')
  @ApiOperation({ summary: 'Get available regions for provider' })
  @ApiParam({ name: 'provider', enum: CloudProvider })
  @ApiResponse({
    status: 200,
    description: 'Available regions',
    type: [Object],
  })
  async getProviderRegions(@Param('provider') provider: CloudProvider) {
    return this.managementService.getProviderRegions(provider);
  }

  @Get('providers/:provider/instance-types')
  @ApiOperation({ summary: 'Get supported instance types for provider' })
  @ApiParam({ name: 'provider', enum: CloudProvider })
  @ApiResponse({
    status: 200,
    description: 'Supported instance types',
    type: [Object],
  })
  async getProviderInstanceTypes(@Param('provider') provider: CloudProvider) {
    return this.managementService.getProviderInstanceTypes(provider);
  }

  @Get('providers/:provider/health')
  @ApiOperation({ summary: 'Get provider health status' })
  @ApiParam({ name: 'provider', enum: CloudProvider })
  @ApiResponse({
    status: 200,
    description: 'Provider health status',
    type: HealthStatusDto,
  })
  @ApiResponse({ status: 404, description: 'Provider not configured' })
  async getProviderHealth(
    @Param('provider') provider: CloudProvider,
  ): Promise<HealthStatusDto> {
    return this.managementService.getProviderHealth(provider);
  }

  @Get('configuration/mode')
  @ApiOperation({ summary: 'Get configuration mode and capabilities' })
  @ApiResponse({
    status: 200,
    description: 'Configuration mode information',
  })
  async getConfigurationMode() {
    return this.managementService.getConfigurationMode();
  }

  @Delete('configurations/:id')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ApiOperation({ summary: 'Remove provider configuration' })
  @ApiParam({ name: 'id', description: 'Configuration ID' })
  @ApiResponse({
    status: 204,
    description: 'Provider configuration removed',
  })
  @ApiResponse({ status: 404, description: 'Configuration not found' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeProviderConfiguration(
    @Param('id') configId: string,
  ): Promise<void> {
    await this.managementService.removeProviderConfiguration(configId);
  }

  @Get('providers/:provider/node-sizes')
  @ApiOperation({ summary: 'Get available node sizes for provider' })
  @ApiParam({
    name: 'provider',
    enum: CloudProvider,
    description: 'Cloud provider name',
  })
  @ApiQuery({
    name: 'region',
    required: false,
    type: String,
    description: 'Filter by region/location (e.g., nbg1, fsn1)',
  })
  @ApiQuery({
    name: 'skipCache',
    required: false,
    type: Boolean,
    description: 'Skip cache and fetch fresh data from provider',
  })
  @ApiResponse({
    status: 200,
    description: 'Available node sizes (server types)',
    type: [NodeSizeOptionDto],
  })
  @ApiResponse({ status: 404, description: 'Provider not found' })
  @ApiResponse({ status: 500, description: 'Failed to fetch node sizes' })
  async getProviderNodeSizes(
    @Param('provider') provider: CloudProvider,
    @Query('region') region?: string,
    @Query('skipCache') skipCache?: boolean,
  ): Promise<NodeSizeOptionDto[]> {
    return this.managementService.getNodeSizes(provider, region, skipCache);
  }

  @Get('providers/:provider/pricing')
  @ApiOperation({ summary: 'Get pricing information for provider' })
  @ApiParam({
    name: 'provider',
    enum: CloudProvider,
    description: 'Cloud provider name',
  })
  @ApiQuery({
    name: 'region',
    required: false,
    description: 'Filter by region/location (e.g., nbg1, fsn1)',
  })
  @ApiQuery({
    name: 'nodeSize',
    required: false,
    description: 'Filter by node size/server type name (e.g., cx11, cx21)',
  })
  @ApiQuery({
    name: 'skipCache',
    required: false,
    type: Boolean,
    description: 'Skip cache and fetch fresh data from provider',
  })
  @ApiResponse({
    status: 200,
    description: 'Pricing information',
    type: PricingResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Provider not found' })
  @ApiResponse({ status: 500, description: 'Failed to fetch pricing' })
  async getProviderPricing(
    @Param('provider') provider: CloudProvider,
    @Query() query: PricingQueryDto,
    @Query('skipCache') skipCache?: boolean,
  ): Promise<PricingResponseDto> {
    return this.managementService.getPricing(provider, query, skipCache);
  }

  @Delete('cache/providers/:provider/node-sizes')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ApiOperation({ summary: 'Clear node sizes cache for provider' })
  @ApiParam({
    name: 'provider',
    enum: CloudProvider,
    description: 'Cloud provider name',
  })
  @ApiResponse({
    status: 204,
    description: 'Cache cleared successfully',
  })
  @ApiResponse({ status: 404, description: 'Provider not found' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearNodeSizesCache(
    @Param('provider') provider: CloudProvider,
  ): Promise<void> {
    return this.managementService.clearNodeSizesCache(provider);
  }
}
