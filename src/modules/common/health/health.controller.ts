import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PingResponseDto } from './dto/ping-response.dto';
import { OidcReadinessDto } from './dto/oidc-readiness.dto';
import { Public } from '../../auth/decorators/public.decorator';
import { OidcBootstrapService } from '../../auth/services/oidc-bootstrap.service';

@ApiTags('Health')
@Public()
@Controller('health')
export class HealthController {
  private readonly startTime: number;

  constructor(private readonly oidcBootstrapService: OidcBootstrapService) {
    this.startTime = Date.now();
  }

  @Get('ping')
  @ApiOperation({
    summary: 'Health ping endpoint',
    description:
      'Ultra-fast health check endpoint that returns server status without checking external dependencies. Ideal for load balancers and frequent monitoring.',
  })
  @ApiResponse({
    status: 200,
    description: 'Server is running',
    type: PingResponseDto,
  })
  ping(): PingResponseDto {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  @Get('oidc')
  @ApiOperation({
    summary: 'OIDC provisioning readiness',
    description:
      'Returns ready=true when the API has the OIDC client_id (OIDC_AUDIENCE) injected by OidcBootstrapService. Used by the CLI to gate "Cluster is READY!" until login is functional.',
  })
  @ApiResponse({
    status: 200,
    description: 'OIDC readiness status',
    type: OidcReadinessDto,
  })
  async oidcReadiness(): Promise<OidcReadinessDto> {
    // Read the live config (not process.env, which the kubeconfig restart
    // wipes) so readiness matches what /auth/config serves to the dashboard.
    const cfg = await this.oidcBootstrapService.getPublicOidcConfig();
    return { ready: cfg.authMode !== 'oidc' || !!cfg.clientId };
  }
}
