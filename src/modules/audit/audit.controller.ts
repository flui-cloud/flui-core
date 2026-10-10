import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequireSection } from '../iam/decorators/require-section.decorator';
import { RequirePermission } from '../iam/decorators/require-permission.decorator';
import { SECTION } from '../iam/constants/iam-sections';
import { IAM_PERMISSION } from '../iam/constants/iam-permissions';
import { AuditService } from './audit.service';
import {
  AuditEventResponseDto,
  ListAuditEventsQueryDto,
} from './dto/audit-event.dto';

@ApiTags('Audit')
@ApiBearerAuth()
@Controller('audit')
@RequireSection(SECTION.ACCESS)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('events')
  @RequirePermission(IAM_PERMISSION.IAM_READ_ACCESS)
  @ApiOperation({
    summary: 'Who did what on this installation',
    description:
      'Every change, every refusal and every read of application data, newest first. Filter by person, time, outcome, or only what reached application data. Pass the id of the last record as `before` to read the next page.',
  })
  @ApiResponse({ status: 200, type: [AuditEventResponseDto] })
  list(@Query() query: ListAuditEventsQueryDto) {
    return this.audit.list({
      email: query.email,
      since: query.since ? new Date(query.since) : undefined,
      until: query.until ? new Date(query.until) : undefined,
      dataAccess: query.dataAccess,
      outcome: query.outcome,
      before: query.before,
      limit: query.limit ?? 100,
    });
  }
}
