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
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { SECTION } from '../../iam/constants/iam-sections';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { DnsZoneService } from '../services/dns-zone.service';
import { Public } from '../../auth/decorators/public.decorator';
import { CreateDnsZoneDto } from '../dto/create-dns-zone.dto';
import { DnsZoneResponseDto } from '../dto/dns-zone-response.dto';
import { DnsLookupResponseDto } from '../dto/dns-lookup-response.dto';
import { DnsProvider } from '../../providers/enums/dns-provider.enum';
import { DnsZoneInfo } from '../../providers/interfaces/dns-provider.interface';

@ApiTags('DNS Zones')
@ApiBearerAuth()
@Controller('dns/zones')
export class DnsZoneController {
  constructor(private readonly dnsZoneService: DnsZoneService) {}

  // The registry is instance-wide and registering calls the provider account,
  // so it sits with the sibling delete rather than with the reads below.
  @Post()
  @RequireSection(SECTION.INFRASTRUCTURE)
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ApiOperation({
    summary: 'Register a DNS zone',
    description:
      'Register a DNS zone from your provider account. ' +
      'The zone must already exist in the provider. ' +
      'Once registered, it can be assigned to clusters.',
  })
  @ApiResponse({ status: 201, type: DnsZoneResponseDto })
  @ApiResponse({ status: 400, description: 'Zone not found in provider' })
  @ApiResponse({ status: 409, description: 'Zone already registered' })
  async createZone(@Body() dto: CreateDnsZoneDto): Promise<DnsZoneResponseDto> {
    const zone = await this.dnsZoneService.createZone(dto);
    return this.dnsZoneService.toResponseDto(zone);
  }

  // Reading the registry is not the same decision as growing it: the cluster
  // DNS tab and `flui dns zone list` are reached by people who operate clusters
  // without administering the infrastructure, and the response carries no
  // credential.
  @Get()
  @RequireSection(SECTION.CLUSTERS)
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({ summary: 'List all registered DNS zones' })
  @ApiResponse({ status: 200, type: [DnsZoneResponseDto] })
  async listZones(): Promise<DnsZoneResponseDto[]> {
    const zones = await this.dnsZoneService.listZones();
    return zones.map((z) => this.dnsZoneService.toResponseDto(z));
  }

  // Authenticated, and deliberately nothing more. It is a live lookup through
  // the server's resolver on a caller-supplied hostname — as a `@Public()` route
  // that is a resolution oracle for anyone at all — but the endpoint form that
  // calls it sits in the application DNS tab, so a section gate would take it
  // away from every operator below maintainer.
  @Get('verify')
  @ApiOperation({
    summary: 'Verify that a hostname resolves to an expected IP',
    description:
      'Performs a live DNS A record lookup for the given hostname and checks whether it resolves to the expected IP address. ' +
      'Useful for validating that a custom domain is correctly pointed to a cluster before or after reconciliation.',
  })
  @ApiQuery({
    name: 'hostname',
    description: 'The hostname to look up',
    example: 'grafana.example.com',
  })
  @ApiQuery({
    name: 'expectedIp',
    description: 'The expected IP address',
    example: '1.2.3.4',
  })
  @ApiResponse({ status: 200, type: DnsLookupResponseDto })
  async verifyDns(
    @Query('hostname') hostname: string,
    @Query('expectedIp') expectedIp: string,
  ): Promise<DnsLookupResponseDto> {
    return this.dnsZoneService.verifyDnsResolution(hostname, expectedIp);
  }

  @Get(':id')
  @RequireSection(SECTION.CLUSTERS)
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({ summary: 'Get a DNS zone by ID' })
  @ApiParam({ name: 'id', description: 'DNS zone ID' })
  @ApiResponse({ status: 200, type: DnsZoneResponseDto })
  @ApiResponse({ status: 404, description: 'Zone not found' })
  async getZone(@Param('id') id: string): Promise<DnsZoneResponseDto> {
    const zone = await this.dnsZoneService.getZone(id);
    return this.dnsZoneService.toResponseDto(zone);
  }

  @Delete(':id')
  @RequireSection(SECTION.INFRASTRUCTURE)
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a registered DNS zone',
    description:
      'Remove a zone registration. Zone must not be assigned to any cluster.',
  })
  @ApiParam({ name: 'id', description: 'DNS zone ID' })
  @ApiResponse({ status: 204, description: 'Zone removed' })
  @ApiResponse({
    status: 409,
    description: 'Zone is assigned to one or more clusters',
  })
  async deleteZone(@Param('id') id: string): Promise<void> {
    await this.dnsZoneService.deleteZone(id);
  }

  @Get('/providers/list')
  @Public()
  @ApiOperation({ summary: 'List supported DNS providers' })
  @ApiResponse({ status: 200, description: 'List of supported providers' })
  async listProviders(): Promise<{ providers: DnsProvider[] }> {
    return { providers: this.dnsZoneService.getSupportedDnsProviders() };
  }

  // The permission is not redundant beside the section: the section guard steps
  // aside for an administrator without ever consulting the credential ceiling,
  // so a section-only route is open to any agent key an administrator minted,
  // whatever scope it declares. This one queries the provider account.
  @Get('/providers/:provider/zones')
  @RequireSection(SECTION.INFRASTRUCTURE)
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List available zones from a DNS provider',
    description:
      'Query the provider account to discover zones available for registration.',
  })
  @ApiParam({ name: 'provider', enum: DnsProvider })
  @ApiResponse({ status: 200, description: 'Zones from provider' })
  async listProviderZones(
    @Param('provider') provider: DnsProvider,
  ): Promise<{ zones: DnsZoneInfo[] }> {
    const zones = await this.dnsZoneService.listProviderZones(provider);
    return { zones };
  }
}
