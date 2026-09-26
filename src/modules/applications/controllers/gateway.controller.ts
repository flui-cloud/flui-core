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
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AppAccessGuard } from '../guards/app-access.guard';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { GatewayService } from '../services/gateway.service';
import {
  AddGatewayRouteDto,
  ClusterGatewayRouteDto,
  CompiledGatewayRouteDto,
  GatewayRouteDto,
  GatewayRouteSyncDto,
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
      'Compiles the route policies and brings the address record, route and certificate in line; a failed certificate is ordered again. `sync` says what was done.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({ name: 'endpointId', description: 'Route (endpoint) ID' })
  @ApiResponse({ status: 200, type: GatewayRouteSyncDto })
  async reconcile(
    @Param('id') appId: string,
    @Param('endpointId') endpointId: string,
  ): Promise<GatewayRouteSyncDto> {
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

  // Scoped in the service rather than gated on a section here, deliberately.
  // A section would have closed the view to every operator whose grant is a
  // project — including the agent tool that reaches this route — while the
  // actual defect is that it answered with other tenants' routes. `app:read` is
  // what the filter resolves against, and it is the permission the credential
  // ceiling is then checked on.
  @Get('routes')
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'List gateway routes on a cluster',
    description:
      'Every route on the cluster that you may see, with its policies and owning app — scoped to the applications you can read. Operate on routes from the owning application scope.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({ status: 200, type: [ClusterGatewayRouteDto] })
  async listRoutes(
    @Param('clusterId') clusterId: string,
    @Req() req: Request,
  ): Promise<ClusterGatewayRouteDto[]> {
    return this.gateway.listClusterRoutes(
      clusterId,
      req.user as AuthenticatedUser | undefined,
    );
  }
}
