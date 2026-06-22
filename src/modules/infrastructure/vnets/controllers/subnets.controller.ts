import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
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
import { SubnetsService } from '../services/subnets.service';
import {
  AttachServerToSubnetDto,
  DetachServerFromSubnetDto,
  SubnetResponseDto,
  SubnetListResponseDto,
} from '../dto';
import { RequireSection } from '../../../iam/decorators/require-section.decorator';

@ApiTags('Subnets')
@ApiBearerAuth()
@Controller('subnets')
@RequireSection('infrastructure')
export class SubnetsController {
  constructor(private readonly subnetsService: SubnetsService) {}

  @Get()
  @ApiOperation({ summary: 'List all subnets' })
  @ApiQuery({
    name: 'vnetId',
    required: false,
    description: 'Filter by VNet ID',
  })
  @ApiQuery({
    name: 'provider',
    required: false,
    description: 'Filter by cloud provider',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of subnets',
    type: SubnetListResponseDto,
  })
  async listSubnets(
    @Query('vnetId') vnetId?: string,
    @Query('provider') provider?: string,
  ): Promise<SubnetListResponseDto> {
    return this.subnetsService.listSubnets({ vnetId, provider });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get subnet by ID' })
  @ApiParam({
    name: 'id',
    description: 'Subnet ID (UUID)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Subnet details',
    type: SubnetResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Subnet not found',
  })
  async getSubnet(@Param('id') id: string): Promise<SubnetResponseDto> {
    return this.subnetsService.getSubnet(id);
  }

  @Post(':id/attach-server')
  @ApiOperation({
    summary: 'Attach a server to a specific subnet',
    description:
      'Attaches a server to this subnet by assigning an IP address from the subnet range. ' +
      'The IP can be specified or auto-assigned. This is the correct way to associate servers ' +
      'with networks, as servers are actually attached to specific subnets, not to VNets directly.',
  })
  @ApiParam({
    name: 'id',
    description: 'Subnet ID (UUID)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Server attached successfully',
    type: SubnetResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Subnet not found',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Failed to attach server (e.g., IP not in subnet range)',
  })
  async attachServer(
    @Param('id') id: string,
    @Body() attachDto: AttachServerToSubnetDto,
  ): Promise<SubnetResponseDto> {
    return this.subnetsService.attachServerToSubnet(id, attachDto);
  }

  @Post(':id/detach-server')
  @ApiOperation({
    summary: 'Detach a server from a specific subnet',
    description:
      'Detaches a server from this subnet, removing its IP assignment. ' +
      'The server will no longer have network connectivity through this subnet.',
  })
  @ApiParam({
    name: 'id',
    description: 'Subnet ID (UUID)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Server detached successfully',
    type: SubnetResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Subnet not found',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Failed to detach server',
  })
  async detachServer(
    @Param('id') id: string,
    @Body() detachDto: DetachServerFromSubnetDto,
  ): Promise<SubnetResponseDto> {
    return this.subnetsService.detachServerFromSubnet(id, detachDto);
  }
}
