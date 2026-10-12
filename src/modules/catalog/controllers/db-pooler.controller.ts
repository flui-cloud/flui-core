import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  AppAccessGuard,
  AppAction,
} from '../../applications/guards/app-access.guard';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { DbPoolerService } from '../services/db-pooler.service';
import { DbPoolerStatusDto } from '../dto/db-pooler-status.dto';

@ApiTags('Applications')
@ApiBearerAuth()
@Controller('applications/:id/db/pooler')
@UseGuards(AppAccessGuard)
export class DbPoolerController {
  constructor(private readonly poolers: DbPoolerService) {}

  @Get()
  @AppAction(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'The connection pooler of a managed PostgreSQL',
    description:
      'Whether the database has a pooler, its mode, whether FLUI_CONNECTION_URL goes through it and, when it does not, why. ' +
      'Also the two in-cluster addresses: pooled (FLUI_CONNECTION_URL) and direct (FLUI_DIRECT_URL).',
  })
  @ApiParam({ name: 'id', description: 'Application id of the database' })
  @ApiResponse({ status: 200, type: DbPoolerStatusDto })
  status(@Param('id') id: string): Promise<DbPoolerStatusDto> {
    return this.poolers.status(id);
  }
}
