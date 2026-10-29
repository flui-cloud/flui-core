import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { EnableReplicatedVolumesDto } from '../dto/enable-replicated-volumes.dto';
import { ReplicatedVolumesService } from '../services/replicated-volumes.service';

@ApiTags('Infrastructure - Clusters')
@ApiBearerAuth()
@Controller('infrastructure/clusters/:id/replicated-volumes')
export class ReplicatedVolumesController {
  constructor(private readonly service: ReplicatedVolumesService) {}

  @Get()
  @RequireSection('clusters')
  @ApiOperation({
    summary: 'Whether a cluster offers replicated volumes',
    description:
      'A replicated volume keeps a synchronous copy in a second location, so an application with one writer comes back there when its server or its location is lost; the third location only votes. ' +
      '`enabled` says whether the `flui-replicated` storage class exists; `storageNodes` are the nodes that hold copies; `warnings` names copies an application could not follow; `plan` is what enabling would do with the nodes the cluster has now, or why it cannot.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  view(@Param('id') id: string) {
    return this.service.view(id);
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireSection('infrastructure')
  @ActionCycle({
    action: 'POST /infrastructure/clusters/:id/replicated-volumes',
    bind: ['id'],
    sentence: 'enable replicated volumes on cluster {id}',
    consequence:
      'A node in each of two locations sets aside disk space for copies of replicated volumes and the volume engine is installed on the cluster. Existing volumes do not change; only volumes created later with `replicated: true` are copied.',
  })
  @ApiOperation({
    summary: 'Enable replicated volumes on a cluster',
    description:
      "Prepares a node in each of the layout's two locations for data to hold copies, installs the volume engine and creates the `flui-replicated` storage class. Nothing changes for existing volumes. " +
      'Refused, with the reason, when the cluster is not yet highly available across three locations of a validated region (`force` accepts a region Flui has not validated), or lacks a node that takes applications in a location for data. Returns the operation to follow.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  enable(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: EnableReplicatedVolumesDto,
  ) {
    const user = req.user as { id?: string; userId?: string } | undefined;
    return this.service.enable(id, dto, user?.id ?? user?.userId);
  }
}
