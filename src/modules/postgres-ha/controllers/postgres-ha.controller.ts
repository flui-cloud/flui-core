import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import {
  AppAccessGuard,
  AppAction,
} from '../../applications/guards/app-access.guard';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { DataDoor } from '../../iam/decorators/data-door.decorator';
import { isSandboxGuestRequest } from '../../sandbox/guards/sandbox-guest-request';
import { ActivateDatabaseHaDto } from '../dto/activate-database-ha.dto';
import { PostgresHaService } from '../services/postgres-ha.service';

/** A second copy on another server, and an operator for the whole cluster: not a demo tenancy's to start. */
const GUEST_HA_REFUSAL =
  'Highly available databases are not available to demo guests: they take a second server of the shared cluster.';

@ApiTags('Applications')
@ApiBearerAuth()
@Controller('applications/:id/db/high-availability')
@UseGuards(AppAccessGuard)
export class PostgresHaController {
  constructor(private readonly service: PostgresHaService) {}

  @Get()
  @AppAction(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'Whether a managed PostgreSQL is highly available',
    description:
      'Null `state` is the single instance. Otherwise the highly available cluster, one instance in each of three locations, what happens to writes when a copy is away (`durability`) and where the move stands.',
  })
  @ApiParam({ name: 'id', description: 'Application id of the database' })
  view(@Param('id') id: string) {
    return this.service.view(id);
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @AppAction(IAM_PERMISSION.APP_DEPLOY)
  @DataDoor()
  @ActionCycle({
    action: 'POST /applications/:id/db/high-availability',
    bind: ['id'],
    sentence: 'make database {id} highly available',
    consequence:
      "Three instances of the database are built, one in each of the cluster's three locations, and take storage there. Once they have caught up, writes stop for a few seconds while the application moves to the new primary; the single instance is then kept stopped, with its data, as the way back.",
  })
  @ApiOperation({
    summary: 'Make a managed PostgreSQL highly available',
    description:
      "Builds a highly available cluster, one instance in each of the cluster's three locations, as a live copy of the database and moves the application to it, without stopping the application: writes pause for a few seconds. A commit waits for whichever copy answers first. " +
      'Refused, with the reason, when the database is not Flui-managed PostgreSQL or the cluster is not yet highly available across three locations of a validated region (`force` accepts a region Flui has not validated). Returns the operation to follow.',
  })
  @ApiParam({ name: 'id', description: 'Application id of the database' })
  activate(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: ActivateDatabaseHaDto,
  ) {
    if (isSandboxGuestRequest(req)) {
      throw new ForbiddenException(GUEST_HA_REFUSAL);
    }
    const user = req.user as { id?: string; userId?: string } | undefined;
    return this.service.activate(id, dto, user?.id ?? user?.userId);
  }
}
