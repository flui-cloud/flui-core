import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { AdminGuard } from '../../auth/guards/admin.guard';
import { Admin } from '../../auth/decorators/admin.decorator';
import { DnsZoneReplicaService } from '../services/dns-zone-replica.service';
import { DnsZoneReplicaResponseDto } from '../dto/dns-zone-replica-response.dto';
import { RegisterDnsReplicaDto } from '../dto/register-dns-replica.dto';
import { ReplicaDiffReport } from '../services/dns-zone-reconciliation.service';

@ApiTags('DNS Zone Replicas')
@ApiBearerAuth()
@Controller('dns/zones/:zoneId/replicas')
export class DnsZoneReplicaController {
  constructor(private readonly replicaService: DnsZoneReplicaService) {}

  @Get()
  @ApiOperation({
    summary: 'List redundancy replicas of a DNS zone',
    description:
      'A logical zone can be published on additional DNS providers for redundancy. ' +
      'Every record Flui writes is fanned out to each active replica.',
  })
  @ApiParam({ name: 'zoneId', description: 'DNS zone ID' })
  @ApiResponse({ status: 200, type: [DnsZoneReplicaResponseDto] })
  async list(
    @Param('zoneId') zoneId: string,
  ): Promise<DnsZoneReplicaResponseDto[]> {
    const replicas = await this.replicaService.listReplicas(zoneId);
    return replicas.map((r) => this.replicaService.toResponseDto(r));
  }

  @Post()
  @UseGuards(AdminGuard)
  @Admin()
  @ApiOperation({
    summary: 'Register a redundancy replica for a zone',
    description:
      'Register an existing zone on a second provider as a replica. The zone must ' +
      'already exist in that provider account. The replica starts PENDING — call ' +
      'populate to copy the current records, then verify (and `dig @ns`) before ' +
      'adding the provider nameservers at your registrar.',
  })
  @ApiParam({ name: 'zoneId', description: 'DNS zone ID' })
  @ApiResponse({ status: 201, type: DnsZoneReplicaResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid provider or zone not found in provider',
  })
  @ApiResponse({
    status: 409,
    description: 'Replica already registered for that provider',
  })
  async register(
    @Param('zoneId') zoneId: string,
    @Body() dto: RegisterDnsReplicaDto,
  ): Promise<DnsZoneReplicaResponseDto> {
    const replica = await this.replicaService.registerReplica(zoneId, dto);
    return this.replicaService.toResponseDto(replica);
  }

  @Post(':replicaId/populate')
  @UseGuards(AdminGuard)
  @Admin()
  @ApiOperation({
    summary: 'Populate a replica from Flui state',
    description:
      'Write every record Flui expects for this zone into the replica provider. ' +
      'On success the replica becomes ACTIVE and starts receiving fan-out writes.',
  })
  @ApiParam({ name: 'zoneId', description: 'DNS zone ID' })
  @ApiParam({ name: 'replicaId', description: 'Replica ID' })
  @ApiResponse({ status: 200, description: 'Reconciliation report' })
  async populate(
    @Param('zoneId') zoneId: string,
    @Param('replicaId') replicaId: string,
  ): Promise<ReplicaDiffReport> {
    return this.replicaService.populateReplica(zoneId, replicaId);
  }

  @Post(':replicaId/verify')
  @UseGuards(AdminGuard)
  @Admin()
  @ApiOperation({
    summary: 'Dry-run verify a replica against Flui state',
    description:
      'Report the diff between the replica and the expected record set without ' +
      'making any changes. Use before delegating nameservers at the registrar.',
  })
  @ApiParam({ name: 'zoneId', description: 'DNS zone ID' })
  @ApiParam({ name: 'replicaId', description: 'Replica ID' })
  @ApiResponse({ status: 200, description: 'Dry-run reconciliation report' })
  async verify(
    @Param('zoneId') zoneId: string,
    @Param('replicaId') replicaId: string,
  ): Promise<ReplicaDiffReport> {
    return this.replicaService.verifyReplica(zoneId, replicaId);
  }

  @Post(':replicaId/disable')
  @UseGuards(AdminGuard)
  @Admin()
  @ApiOperation({
    summary: 'Disable a replica (stop fan-out and reconciliation)',
  })
  @ApiParam({ name: 'zoneId', description: 'DNS zone ID' })
  @ApiParam({ name: 'replicaId', description: 'Replica ID' })
  @ApiResponse({ status: 200, type: DnsZoneReplicaResponseDto })
  async disable(
    @Param('zoneId') zoneId: string,
    @Param('replicaId') replicaId: string,
  ): Promise<DnsZoneReplicaResponseDto> {
    const replica = await this.replicaService.setReplicaDisabled(
      zoneId,
      replicaId,
      true,
    );
    return this.replicaService.toResponseDto(replica);
  }

  @Post(':replicaId/enable')
  @UseGuards(AdminGuard)
  @Admin()
  @ApiOperation({ summary: 'Re-enable a disabled replica' })
  @ApiParam({ name: 'zoneId', description: 'DNS zone ID' })
  @ApiParam({ name: 'replicaId', description: 'Replica ID' })
  @ApiResponse({ status: 200, type: DnsZoneReplicaResponseDto })
  async enable(
    @Param('zoneId') zoneId: string,
    @Param('replicaId') replicaId: string,
  ): Promise<DnsZoneReplicaResponseDto> {
    const replica = await this.replicaService.setReplicaDisabled(
      zoneId,
      replicaId,
      false,
    );
    return this.replicaService.toResponseDto(replica);
  }

  @Delete(':replicaId')
  @UseGuards(AdminGuard)
  @Admin()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a replica registration',
    description:
      'Removes the Flui registration only — records already written to the ' +
      'provider are left in place (nameservers may still be delegated there).',
  })
  @ApiParam({ name: 'zoneId', description: 'DNS zone ID' })
  @ApiParam({ name: 'replicaId', description: 'Replica ID' })
  @ApiResponse({ status: 204, description: 'Replica removed' })
  async remove(
    @Param('zoneId') zoneId: string,
    @Param('replicaId') replicaId: string,
  ): Promise<void> {
    await this.replicaService.removeReplica(zoneId, replicaId);
  }
}
