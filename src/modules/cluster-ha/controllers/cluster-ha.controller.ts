import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { ClusterHaService } from '../services/cluster-ha.service';

@ApiTags('Infrastructure - Clusters')
@ApiBearerAuth()
@Controller('infrastructure/clusters/:id/high-availability')
export class ClusterHaController {
  constructor(private readonly service: ClusterHaService) {}

  @Get()
  @RequireSection('clusters')
  @ApiOperation({
    summary:
      'What a cluster survives now, and what it needs to survive the loss of a location',
    description:
      'Flui offers one highly available layout: a server in each of three locations of a region it has validated, copies of data in the two closest, and the third location voting only. ' +
      '`level` is `standard` or `three-locations`; `topology` names each location with its role (`data` or `vote`), its servers and its hosts for data, or is null with the reason in `unsupported`. ' +
      '`survives` and `doesNotSurvive` are plain sentences; `missing` lists the roles to add (`server`, `data-host`) with the location and why. Read from the nodes as they are now. ' +
      '`observed` is what Flui last measured, as of `observed.at`, on a cluster across three locations: the location of the etcd leader, which Flui brings back to a location for data; the round trip in milliseconds between each pair of locations (null when one did not answer); the server Flui reaches the cluster through and the ones it can move to.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  view(@Param('id') id: string) {
    return this.service.view(id);
  }
}
