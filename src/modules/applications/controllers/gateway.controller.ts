import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AppAccessGuard } from '../guards/app-access.guard';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { GatewayService } from '../services/gateway.service';
import {
  AddGatewayRouteDto,
  ClusterGatewayRouteDto,
  CompiledGatewayRouteDto,
  GatewayRouteDto,
  GatewayStatusDto,
  SetGatewayPolicyDto,
} from '../dto/gateway-route.dto';

@ApiTags('Gateway')
@ApiBearerAuth()
@UseGuards(AppAccessGuard)
@Controller('applications/:id/gateway')
export class GatewayController {
  constructor(private readonly gateway: GatewayService) {}

  @Get('routes')
  @ApiOperation({
    summary: 'List gateway routes',
    description:
      "Returns the application's routes (one per endpoint) with their L7 policies. An app without gateway config shows its default routes with no policies.",
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 200, type: [GatewayRouteDto] })
  async listRoutes(@Param('id') appId: string): Promise<GatewayRouteDto[]> {
    return this.gateway.listRoutes(appId);
  }

  @Post('routes')
  @ApiOperation({
    summary: 'Add a gateway route',
    description:
      'Creates a new route (host [+path] → app service) with optional policies. DNS record, TLS certificate and Ingress reconcile in the background — poll the route status.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 201, type: GatewayRouteDto })
  async addRoute(
    @Param('id') appId: string,
    @Body() dto: AddGatewayRouteDto,
  ): Promise<GatewayRouteDto> {
    return this.gateway.addRoute(appId, dto);
  }

  @Patch('routes/:endpointId')
  @ActionCycle({
    action: 'PATCH /applications/:id/gateway/routes/:endpointId',
    bind: ['id', 'endpointId'],
    sentence:
      'change who may reach route {endpointId} of application {id}, and on ' +
      'what terms',
    consequence:
      'Sign-in, rate limit and IP allowlist on that route become what this call says; a policy it leaves out is unchanged, and one it sets to null is removed.',
  })
  @ApiOperation({
    summary: 'Set gateway policies on a route',
    description:
      'Updates auth (SSO/minRole), rate limit, IP allowlist or path. Fields left out are unchanged; explicit null clears a policy. Changes reconcile in the background.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({ name: 'endpointId', description: 'Route (endpoint) ID' })
  @ApiResponse({ status: 200, type: GatewayRouteDto })
  async setPolicy(
    @Param('id') appId: string,
    @Param('endpointId') endpointId: string,
    @Body() dto: SetGatewayPolicyDto,
  ): Promise<GatewayRouteDto> {
    return this.gateway.setPolicy(appId, endpointId, dto);
  }

  @Delete('routes/:endpointId')
  @ActionCycle({
    action: 'DELETE /applications/:id/gateway/routes/:endpointId',
    bind: ['id', 'endpointId'],
    sentence:
      'take route {endpointId} of application {id} off the internet, together ' +
      'with its DNS record and its certificate',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a gateway route',
    description:
      'Removes the route and cleans up its DNS record, certificate, Ingress and middlewares.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({ name: 'endpointId', description: 'Route (endpoint) ID' })
  @ApiResponse({ status: 204, description: 'Removed' })
  async removeRoute(
    @Param('id') appId: string,
    @Param('endpointId') endpointId: string,
  ): Promise<void> {
    await this.gateway.removeRoute(appId, endpointId);
  }

  @Post('routes/:endpointId/reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reconcile a gateway route now',
    description:
      'Synchronously compiles the route policies to Traefik resources and refreshes DNS/TLS/Ingress.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({ name: 'endpointId', description: 'Route (endpoint) ID' })
  @ApiResponse({ status: 200, type: GatewayRouteDto })
  async reconcile(
    @Param('id') appId: string,
    @Param('endpointId') endpointId: string,
  ): Promise<GatewayRouteDto> {
    return this.gateway.reconcileRoute(appId, endpointId);
  }

  @Get('routes/:endpointId/compiled')
  @ApiOperation({
    summary: 'Preview the compiled Traefik resources for a route',
    description:
      'Returns the Middleware CRDs and Ingress annotation the reconciler applies for this route, without applying them.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({ name: 'endpointId', description: 'Route (endpoint) ID' })
  @ApiResponse({ status: 200, type: CompiledGatewayRouteDto })
  async compiled(
    @Param('id') appId: string,
    @Param('endpointId') endpointId: string,
  ): Promise<CompiledGatewayRouteDto> {
    return this.gateway.compiledRoute(appId, endpointId);
  }

  @Get('status')
  @ApiOperation({
    summary: 'Gateway reconciliation status',
    description:
      'Per-route reconciliation state (synced / reconciling / error).',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 200, type: GatewayStatusDto })
  async status(@Param('id') appId: string): Promise<GatewayStatusDto> {
    return this.gateway.status(appId);
  }
}

@ApiTags('Gateway')
@ApiBearerAuth()
@Controller('clusters/:clusterId/gateway')
export class ClusterGatewayController {
  constructor(private readonly gateway: GatewayService) {}

  @Get('routes')
  @ApiOperation({
    summary: 'List all gateway routes on a cluster',
    description:
      'Read-only global view: every route across all applications with its policies and owning app. Operate on routes from the owning application scope.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({ status: 200, type: [ClusterGatewayRouteDto] })
  async listRoutes(
    @Param('clusterId') clusterId: string,
  ): Promise<ClusterGatewayRouteDto[]> {
    return this.gateway.listClusterRoutes(clusterId);
  }
}
