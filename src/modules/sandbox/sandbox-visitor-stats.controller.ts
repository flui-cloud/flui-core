import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../iam/constants/iam-permissions';
import { SandboxVisitorStatsDto } from './dto/sandbox-visitor-stats.dto';
import { VisitorStatsService } from './visitors/visitor-stats.service';

@ApiTags('Sandbox')
@Controller('sandbox/visitors')
export class SandboxVisitorStatsController {
  constructor(private readonly stats: VisitorStatsService) {}

  @Get('stats')
  @RequirePermission(IAM_PERMISSION.SANDBOX_OPERATE)
  @ApiOperation({
    summary: 'What the visitors’ entrance has been doing',
    description:
      'Visitors in the demo now, those made ahead of time, the last 24 hours (came in, turned away and why), and how many became an account or were added to one.',
  })
  @ApiResponse({ status: 200, type: SandboxVisitorStatsDto })
  get(): Promise<SandboxVisitorStatsDto> {
    return this.stats.stats();
  }
}
