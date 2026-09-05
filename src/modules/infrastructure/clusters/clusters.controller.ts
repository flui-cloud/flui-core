import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Param,
  Body,
  Query,
  Header,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBody,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ClustersService } from './clusters.service';
import {
  CreateClusterDto,
  CreateClusterResponseDto,
} from './dto/create-cluster.dto';
import { ClusterResponseDto } from './dto/cluster-response.dto';
import { UpdateClusterMetadataDto } from './dto/update-cluster-metadata.dto';
import { UpdateNodeMetadataDto } from './dto/update-node-metadata.dto';
import { FirewallsService } from '../firewalls/services/firewalls.service';
import { ProviderFirewallDto } from '../../providers/dto/firewall.dto';
import {
  ReconcileTagsDto,
  ReconcileTagsResponseDto,
} from './dto/reconcile-tags.dto';
import {
  ReconcileFirewallsDto,
  ReconcileFirewallsResponseDto,
} from './dto/reconcile-firewalls.dto';
import {
  ReconcileStatusDto,
  ReconcileStatusResponseDto,
  ClusterPowerOperationResponseDto,
} from './dto/cluster-power-management.dto';
import { GrafanaDatasourceService } from 'src/modules/grafana/services/grafana-datasource.service';
import { ClusterType } from './entities/cluster.entity';
import { ClusterBillingService } from './services/cluster-billing.service';
import { ClusterBillingResponseDto } from './dto/cluster-billing.dto';
import { ResourceAvailabilityResponseDto } from './dto/resource-availability.dto';
import { BuildResourcesResponseDto } from './dto/build-resources.dto';
import { ResourceProfilesService } from '../../images/services/resource-profiles.service';
import { KubernetesService } from '../shared/services/kubernetes.service';
import { ClusterAutoscaleService } from './services/cluster-autoscale.service';
import { UpdateClusterAutoscaleDto } from './dto/update-cluster-autoscale.dto';
import {
  AutoscaleDefaultsDto,
  AutoscaleStatusDto,
} from './dto/autoscale-status.dto';
import { ClusterVNetService } from './services/cluster-vnet.service';
import {
  AttachClusterToVNetResponseDto,
  UpdateClusterVNetDto,
} from './dto/update-cluster-vnet.dto';
import { ClusterScalingService } from './services/cluster-scaling.service';
import { ClusterStorageService } from './services/cluster-storage.service';
import { AddWorkerDto, AddWorkerResponseDto } from './dto/add-worker.dto';
import {
  RebuildClusterDto,
  RebuildClusterResponseDto,
  RebuildPlanResponseDto,
} from './dto/rebuild-cluster.dto';
import { ClusterRebuildService } from './services/cluster-rebuild.service';
import { Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { RemoveWorkerResponseDto } from './dto/remove-worker.dto';
import { RegisterByosNodeDto } from './dto/register-byos-node.dto';
import { EnsureByosVNetDto } from './dto/byos-vnet.dto';
import {
  IssueJoinTokenDto,
  IssuedJoinTokenResponseDto,
  CompleteJoinDto,
} from './dto/join-token.dto';
import { ByosNodeJoinService } from './services/byos-node-join.service';
import { ByosVNetService } from './services/byos-vnet.service';
import { Public } from '../../auth/decorators/public.decorator';
import { ClusterStorageStatusDto } from './dto/cluster-storage.dto';
import { ClusterCapacityService } from './services/cluster-capacity.service';
import { ClusterCapacityPlanDto } from './dto/cluster-capacity-plan.dto';
import { FleetHistoryDto } from './dto/fleet-history.dto';
import { FleetHistoryService } from './services/fleet-history.service';
import { ClusterNodeScalingService } from './services/cluster-node-scaling.service';
import { ScaleNodeDto, ExpandSharedVolumeDto } from './dto/scale-node.dto';
import { OrphanVolumesService } from './services/orphan-volumes.service';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';

/**
 * `@RequireSection(...)` sits on each route instead of on the class, which is
 * where the sibling controllers (servers, vnets, operations) carry it.
 *
 * Not a stylistic choice: four reads here — the cluster list, `:id`, `:id/nodes`
 * and `:id/resource-availability` — are what the deploy wizard calls, and an
 * operator holds `app:create` without `cluster:manage`, so a class-level gate
 * would answer 403 to the deploy flow of every non-admin.
 *
 * Every other read that no caller needs now carries its section. What is left
 * open, and why, is exactly three things:
 *
 * - the four deploy-wizard reads above;
 * - `:id/billing` and `:id/storage`, which the dashboard calls from tabs a
 *   non-admin can open — gating them takes a screen away, so it is a decision
 *   rather than a decorator;
 * - `autoscale/defaults` and `:id/autoscale/status`, see the note above them.
 *
 * Two of the four deploy-wizard reads — the list and `:id/resource-availability`
 * — now carry `@RequirePermission(APP_READ)`. Not a section, and not
 * `cluster:read`, which would be the honest name. Every rung of the role ladder
 * holds `cluster:read` now, but the **sandbox guest does not**, and it reaches
 * both of these for real through the fence — so naming the honest permission
 * would take the public demonstration down in one line while looking like a
 * tidy-up. `app:read` is what every principal that reaches them today already
 * holds, so it takes nothing from anybody; what it buys is that the credential
 * ceiling can see the routes at all, since it reads `@RequirePermission` and
 * `@AppAction` and nothing else.
 *
 * Moving them to `cluster:read` to close the gap between the name and the
 * permission is explicitly *not* the fix: the gap is one guest role wide, and
 * closing it that way trades a naming blemish for a broken demo.
 */
@ApiTags('Infrastructure - Clusters')
@ApiBearerAuth()
@Controller('infrastructure/clusters')
export class ClustersController {
  constructor(
    private readonly clustersService: ClustersService,
    private readonly firewallsService: FirewallsService,
    private readonly grafanaDatasourceService: GrafanaDatasourceService,
    private readonly clusterBillingService: ClusterBillingService,
    private readonly resourceProfilesService: ResourceProfilesService,
    private readonly kubernetesService: KubernetesService,
    private readonly clusterAutoscaleService: ClusterAutoscaleService,
    private readonly clusterVNetService: ClusterVNetService,
    private readonly clusterScalingService: ClusterScalingService,
    private readonly clusterStorageService: ClusterStorageService,
    private readonly clusterCapacityService: ClusterCapacityService,
    private readonly clusterNodeScalingService: ClusterNodeScalingService,
    private readonly orphanVolumesService: OrphanVolumesService,
    private readonly byosNodeJoinService: ByosNodeJoinService,
    private readonly byosVNetService: ByosVNetService,
    private readonly fleetHistoryService: FleetHistoryService,
    private readonly clusterRebuildService: ClusterRebuildService,
  ) {}

  @Get('orphan-volumes')
  @RequireSection('infrastructure')
  @ApiOperation({
    summary: 'List Flui-managed block storage volumes not tied to any cluster',
    description:
      'Scans Hetzner and Scaleway for volumes carrying the managed-by=flui-cloud tag whose IDs do not match any cluster.sharedStorageVolumeId in the DB. Useful to recover orphan resources left behind by past destroys.',
  })
  async listOrphanVolumes() {
    return this.orphanVolumesService.scan();
  }

  @Delete('orphan-volumes/:provider/:volumeId')
  @RequireSection('infrastructure')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ApiOperation({
    summary: 'Detach and delete an orphan Flui-managed volume',
    description:
      'Refuses to delete if the volume is still referenced by an existing cluster. Pass volumeId in the provider canonical format (Hetzner: numeric; Scaleway: <zone>:<uuid>).',
  })
  async deleteOrphanVolume(
    @Param('provider') provider: string,
    @Param('volumeId') volumeId: string,
  ) {
    return this.orphanVolumesService.cleanup(
      provider as CloudProvider,
      volumeId,
    );
  }

  @Post(':id/workers')
  @RequireSection('infrastructure')
  // The mockup's own example, and the shape a concession is written in: the
  // route pattern *plus* `{id}` bound to one cluster. "Allow always" here means
  // "add nodes to this cluster", never "infrastructure" — which is the whole
  // difference between opening a door and opening a floor.
  @ActionCycle({
    action: 'POST /infrastructure/clusters/:id/workers',
    bind: ['id'],
    sentence: 'add worker nodes to cluster {id}',
    estimate: '/infrastructure/clusters/:id/capacity-plan',
  })
  @ApiOperation({
    summary: 'Add 1..5 worker nodes to an existing cluster',
    description:
      'Provisions new worker nodes inheriting region/size/image from the cluster, ' +
      'attaches them to the cluster VNet (required) and joins them to K3s. ' +
      'Returns an operation ID — track progress via WebSocket namespace /infrastructure. ' +
      'Fails with 400 if cluster has no VNet, is not READY, count is out of [1,5], ' +
      'or projected node count exceeds maxNodes.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiBody({ type: AddWorkerDto, required: false })
  @ApiResponse({ status: 202, type: AddWorkerResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async addWorkers(
    @Param('id') clusterId: string,
    @Body() dto: AddWorkerDto,
  ): Promise<AddWorkerResponseDto> {
    const operation = await this.clusterScalingService.addWorkers(
      clusterId,
      dto?.count ?? 1,
    );
    return {
      operation_id: operation.id,
      resource_id: operation.resourceId,
      status: 'pending',
      estimated_duration: '3-6 minutes per worker',
      created_at: operation.createdAt,
    };
  }

  @Delete(':id/workers/:nodeId')
  @RequireSection('infrastructure')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  // Bound to the node, not to the cluster: "always" here concedes removing
  // THIS node, which is a permission that spends itself the first time it is
  // used. The estimate is the capacity plan — what the cluster is left with.
  @ActionCycle({
    action: 'DELETE /infrastructure/clusters/:id/workers/:nodeId',
    bind: ['id', 'nodeId'],
    sentence: 'drain and delete worker node {nodeId} of cluster {id}',
    estimate: '/infrastructure/clusters/:id/capacity-plan',
  })
  @ApiOperation({
    summary: 'Cordon, drain and remove a worker node',
    description:
      'Cordons the worker, attempts a kubectl drain (timeout 120s), then deletes the underlying server. ' +
      'If drain fails (e.g. PDB blocks eviction), the operation completes anyway with ' +
      'a metadata.warnings entry { code: "DRAIN_FAILED" }. ' +
      'Cannot be used on the master node or when removing would violate cluster.minNodes.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiParam({ name: 'nodeId', description: 'Cluster node ID (worker)' })
  @ApiResponse({ status: 202, type: RemoveWorkerResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  @ApiResponse({ status: 404, description: 'Cluster or node not found' })
  async removeWorker(
    @Param('id') clusterId: string,
    @Param('nodeId') nodeId: string,
  ): Promise<RemoveWorkerResponseDto> {
    const operation = await this.clusterScalingService.removeWorker(
      clusterId,
      nodeId,
    );
    return {
      operation_id: operation.id,
      resource_id: operation.resourceId,
      status: 'pending',
      estimated_duration: '2-3 minutes',
      created_at: operation.createdAt,
    };
  }

  @Get(':id/rebuild-plan')
  @RequireSection('infrastructure')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ApiOperation({
    summary: 'What rebuilding this cluster onto another would do',
    description:
      'Reads the applications recorded against the lost cluster and says, per ' +
      'application, whether it can come back and what it will come back with. ' +
      '`refusals` is empty when the rebuild can start; anything in it stops the ' +
      'whole operation, including the source still answering — a reachable ' +
      'cluster is not lost, and moving one is a migration, not a rebuild.',
  })
  @ApiParam({ name: 'id', description: 'The lost cluster' })
  @ApiQuery({ name: 'to', description: 'The destination cluster ID' })
  @ApiResponse({ status: 200, type: RebuildPlanResponseDto })
  async rebuildPlan(
    @Param('id') clusterId: string,
    @Query('to') to: string,
  ): Promise<RebuildPlanResponseDto> {
    return this.clusterRebuildService.plan(clusterId, to);
  }

  @Post(':id/rebuild')
  @RequireSection('infrastructure')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ApiOperation({
    summary: 'Re-materialise a lost cluster’s applications onto a live one',
    description:
      'Runs the plan first and refuses with 400 if it has any refusal, so a ' +
      'reason reaches the caller instead of a job. Then, per application: ' +
      're-point the records, put the data back, deploy, re-point the endpoints. ' +
      'Never rolls back — a partial rebuild is an honest state a re-run ' +
      'continues from. Returns an operation to follow.',
  })
  @ApiParam({ name: 'id', description: 'The lost cluster' })
  @ApiBody({ type: RebuildClusterDto })
  @ApiResponse({ status: 202, type: RebuildClusterResponseDto })
  @ApiResponse({ status: 400, description: 'The plan refused' })
  async rebuild(
    @Req() req: Request,
    @Param('id') clusterId: string,
    @Body() dto: RebuildClusterDto,
  ): Promise<RebuildClusterResponseDto> {
    const userId = (req.user as AuthenticatedUser | undefined)?.userId ?? '';
    const operation = await this.clusterRebuildService.start(
      userId,
      clusterId,
      dto.to,
      { includeStopped: dto.includeStopped },
    );
    return {
      operation_id: operation.id,
      status: 'pending',
      applications: operation.totalSteps,
    };
  }

  @Post(':id/byos-nodes')
  @RequireSection('infrastructure')
  @ApiOperation({
    summary: 'Register a node joined to a BYOS cluster out-of-band',
    description:
      'Records a node that the operator joined via `flui node connect` (the worker ' +
      'bootstrap runs over the operator SSH key — the in-cluster API cannot reach a ' +
      'host that does not yet trust the Flui CA, so the join is operator-driven). No ' +
      'provisioning happens. Idempotent per (cluster, serverName). Returns the node. ' +
      '400 if the cluster is not BYOS (use POST /workers for provisioned providers).',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiBody({ type: RegisterByosNodeDto })
  @ApiResponse({ status: 201, description: 'Node registered' })
  @ApiResponse({ status: 400, description: 'Cluster is not BYOS' })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async registerByosNode(
    @Param('id') clusterId: string,
    @Body() dto: RegisterByosNodeDto,
  ) {
    const node = await this.clustersService.registerByosNode(clusterId, dto);
    return {
      id: node.id,
      serverName: node.serverName,
      nodeType: node.nodeType,
      ipAddress: node.ipAddress,
      privateIp: node.privateIp,
      status: node.status,
      metadata: node.metadata,
      createdAt: node.createdAt,
    };
  }

  @Post(':id/byos-vnet')
  @RequireSection('infrastructure')
  @ApiOperation({
    summary: 'Register/ensure the private network (VNet) of a BYOS cluster',
    description:
      'Registers the operator-wired private network as a first-class VNet ' +
      '(no provisioning — register + validate), points the cluster at it ' +
      '(metadata.vnetConfig) and attaches every node whose private IP belongs ' +
      'to the CIDR. Idempotent; also backfills clusters created before VNets ' +
      'existed. Body.ipRange is optional (derived from the cluster when omitted). ' +
      '400 if the cluster is not BYOS.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiBody({ type: EnsureByosVNetDto, required: false })
  @ApiResponse({ status: 201, description: 'VNet ensured' })
  @ApiResponse({ status: 400, description: 'Cluster is not BYOS' })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async ensureByosVNet(
    @Param('id') clusterId: string,
    @Body() dto?: EnsureByosVNetDto,
  ) {
    return this.byosVNetService.ensureClusterVNet(clusterId, {
      ipRange: dto?.ipRange,
    });
  }

  @Post(':id/join-tokens')
  @RequireSection('infrastructure')
  @ApiOperation({
    summary: 'Issue a short-lived worker join token for a BYOS cluster',
    description:
      'Returns an opaque single-use token (~30 min) + a one-liner to run on the new ' +
      'host. The host fetches the join material over TLS, runs the worker bootstrap, ' +
      'self-applies the firewall and registers itself — no SSH key leaves the operator. ' +
      'Also pre-authorises the host firewall so the new node can reach the master.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID (BYOS)' })
  @ApiBody({ type: IssueJoinTokenDto, required: false })
  @ApiResponse({ status: 201, type: IssuedJoinTokenResponseDto })
  @ApiResponse({ status: 400, description: 'Cluster is not BYOS' })
  async issueJoinToken(
    @Param('id') clusterId: string,
    @Body() dto: IssueJoinTokenDto,
  ): Promise<IssuedJoinTokenResponseDto> {
    return this.byosNodeJoinService.issueToken(clusterId, dto ?? {});
  }

  @Public()
  @Get(':id/join/:token')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @ApiOperation({
    summary: 'Fetch the host-pull join script for a join token (single-use)',
    description:
      'Returns the bash script the new host runs. Authenticated by the token in the ' +
      'path (no bearer). Consumes the token. Intended for `curl … | sudo bash`.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiParam({ name: 'token', description: 'Join token' })
  async getJoinScript(
    @Param('id') clusterId: string,
    @Param('token') token: string,
  ): Promise<string> {
    return this.byosNodeJoinService.buildJoinScript(clusterId, token);
  }

  @Public()
  @Post(':id/join/:token/complete')
  @ApiOperation({
    summary:
      'Register a node that joined via a join token (called by the script)',
    description:
      'Token-authenticated callback the join script makes after the host joins. ' +
      'Records the node so the dashboard lists it and the firewall can enforce on it.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiParam({ name: 'token', description: 'Join token' })
  @ApiBody({ type: CompleteJoinDto })
  async completeJoin(
    @Param('id') clusterId: string,
    @Param('token') token: string,
    @Body() dto: CompleteJoinDto,
  ) {
    return this.byosNodeJoinService.completeJoin(clusterId, token, dto ?? {});
  }

  /*
   * These two reads carry the `clusters` section, which is `cluster:read` —
   * the same gate the cluster menu entry already sits behind, so `viewer`,
   * `operator` and `maintainer` all keep them.
   *
   * The dashboard reaches them from a hand-written HttpClient service rather
   * than the generated client, which is why a search by generated method name
   * finds nothing: `cluster-autoscale.service.ts` calls them from the cluster
   * tabs *and* from the home pulse, which every authenticated person opens. The
   * pulse swallowed the failure (`Promise.allSettled`), so a section here would
   * have silently dropped the pressure badge for anyone without the section —
   * which is why the pulse now asks `canSee('clusters')` before calling at all,
   * and the two halves had to land together.
   */
  @Get('autoscale/defaults')
  @RequireSection('clusters')
  @ApiOperation({
    summary: 'Get global autoscale default thresholds',
    description:
      'Returns the platform-wide default thresholds used when a cluster has no overrides.',
  })
  @ApiResponse({ status: 200, type: AutoscaleDefaultsDto })
  getAutoscaleDefaults(): AutoscaleDefaultsDto {
    return this.clusterAutoscaleService.getDefaults();
  }

  @Get(':id/autoscale/status')
  @RequireSection('clusters')
  @ApiOperation({
    summary: 'Get cluster autoscale status',
    description:
      'Returns autoscaling configuration, current node count, live Prometheus metrics ' +
      'and a warning level (NONE | WARN_NEEDS_AUTOSCALE | DANGER_NEEDS_SCALE).',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiResponse({ status: 200, type: AutoscaleStatusDto })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async getAutoscaleStatus(
    @Param('id') clusterId: string,
  ): Promise<AutoscaleStatusDto> {
    return this.clusterAutoscaleService.getStatus(clusterId);
  }

  /*
   * The same `clusters` section as the two autoscale reads above, and the
   * permission it already implies written out beside it so the credential
   * ceiling can see the route at all. `scale:execute` is deliberately not
   * reused: it guards application scaling, and a key minted to restart an app
   * has no business reading a cluster's fleet.
   */
  @Get(':id/fleet/history')
  @RequireSection('clusters')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'Get the fleet over time, one series per node shape',
    description:
      'Counts node lifetimes from the billable intervals into a series per ' +
      'server type, with the fleet cost per hour on the same samples. ' +
      'Intervals whose node row no longer exists are counted and reported ' +
      'separately rather than dropped.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiQuery({
    name: 'days',
    required: false,
    description: 'Window length, 1-365, default 30',
  })
  @ApiQuery({
    name: 'stepHours',
    required: false,
    description: 'Sampling step, 1-168, default 24',
  })
  @ApiResponse({ status: 200, type: FleetHistoryDto })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async getFleetHistory(
    @Param('id') clusterId: string,
    @Query('days') days?: string,
    @Query('stepHours') stepHours?: string,
  ): Promise<FleetHistoryDto> {
    return this.fleetHistoryService.getHistory(clusterId, {
      days: parsePositive(days),
      stepHours: parsePositive(stepHours),
    });
  }

  @Patch(':id/autoscale')
  @RequireSection('infrastructure')
  @ActionCycle({
    action: 'PATCH /infrastructure/clusters/:id/autoscale',
    bind: ['id'],
    sentence: 'change how cluster {id} scales itself',
    estimate: '/infrastructure/clusters/:id/capacity-plan',
  })
  @ApiOperation({
    summary: 'Update cluster autoscale configuration',
    description:
      'Updates autoscaling enable flag, min/max nodes and optional threshold overrides. ' +
      'Enabling autoscale on a cluster without VNet returns 400 — re-create the cluster ' +
      'with autoscalingEnabled=true to get a VNet automatically provisioned.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiBody({ type: UpdateClusterAutoscaleDto })
  @ApiResponse({ status: 200, type: AutoscaleStatusDto })
  @ApiResponse({ status: 400, description: 'Invalid autoscale configuration' })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async updateAutoscale(
    @Param('id') clusterId: string,
    @Body() dto: UpdateClusterAutoscaleDto,
  ): Promise<AutoscaleStatusDto> {
    await this.clusterAutoscaleService.updateAutoscale(clusterId, dto);
    return this.clusterAutoscaleService.getStatus(clusterId);
  }

  @Patch(':id/vnet')
  @RequireSection('infrastructure')
  @ApiOperation({
    summary: 'Attach an existing cluster to a VNet/subnet',
    description:
      'Asynchronously attaches all nodes of an existing cluster to the specified VNet/subnet. ' +
      'Returns an operation ID — clients should subscribe via WebSocket namespace /infrastructure ' +
      'with subscribe:operation { operationId } to receive progress events. ' +
      'Fails with 400 if the provider does not support VNet attachment (e.g. Contabo) or if VNet/cluster providers differ. ' +
      'Fails with 409 if the cluster is already attached to a different VNet (detach first).',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiBody({ type: UpdateClusterVNetDto })
  @ApiResponse({ status: 202, type: AttachClusterToVNetResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid request or unsupported provider',
  })
  @ApiResponse({ status: 404, description: 'Cluster or VNet not found' })
  @ApiResponse({
    status: 409,
    description: 'Cluster already attached to a different VNet',
  })
  async attachClusterToVNet(
    @Param('id') clusterId: string,
    @Body() dto: UpdateClusterVNetDto,
  ): Promise<AttachClusterToVNetResponseDto> {
    const operation = await this.clusterVNetService.attachClusterToVNet(
      clusterId,
      dto,
    );
    return {
      operationId: operation.id,
      clusterId,
      status: operation.status.toLowerCase(),
      websocketNamespace: '/infrastructure',
    };
  }

  @Post()
  @RequireSection('infrastructure')
  // No `bind`, and that is an answer rather than an omission: the cluster does
  // not exist yet, so the request cannot state its own edge and is offered only
  // "allow once". A standing permission to create clusters is a standing
  // permission to spend.
  @ActionCycle({
    action: 'POST /infrastructure/clusters',
    sentence: 'create a new cluster at a cloud provider',
    consequence:
      'Servers are bought at the provider and billed from the moment they boot.',
  })
  @ApiOperation({
    summary: 'Create a new K3s cluster',
    description:
      'Initiates K3s cluster creation via async queue. Returns operation ID for tracking progress.',
  })
  @ApiBody({ type: CreateClusterDto })
  @ApiResponse({
    status: 202,
    description: 'Cluster creation initiated',
    type: CreateClusterResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  async createCluster(
    @Body() dto: CreateClusterDto,
  ): Promise<CreateClusterResponseDto> {
    const operation = await this.clustersService.createCluster(dto);
    return {
      operation_id: operation.id,
      resource_id: operation.resourceId,
      cluster_id: operation.resourceId, // Alias for backward compatibility
      status: 'pending',
      estimated_duration: '8-15 minutes',
      created_at: operation.createdAt,
    };
  }

  /*
   * There is no `POST register` here any more. It had no caller: not the CLI
   * (`flui env create` writes the control-cluster row through its own
   * repository, in process), not the bootstrap scripts, not the dashboard —
   * only the generated Angular client, which nothing calls. Adopting an
   * installation somebody else provisioned goes through `/adoption/*`.
   *
   * A dead route is removed rather than decorated: deciding which permission
   * should guard something nobody calls is an answer to a question nobody
   * asked. `ClustersService.registerCluster` and the two DTOs are now
   * unreferenced too — see decision 37.
   */

  @Get()
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'List all active clusters',
    description:
      'Returns all K3s clusters except those with DELETED status, including their current status and nodes',
  })
  @ApiResponse({
    status: 200,
    description: 'List of clusters',
    type: [ClusterResponseDto],
  })
  async listClusters(): Promise<ClusterResponseDto[]> {
    return this.clustersService.listClusters();
  }

  /*
   * There is no `GET :id/inventory` here. Adoption's inventory lives on
   * `GET /adoption/inventory`, behind AdoptionTokenGuard, and that is the one
   * `flui env adopt` calls. This controller carried a second copy of the same
   * ClusterInventoryDto that nothing called and that could not have served
   * adoption anyway: it read `metadata.endpoint` and `metadata.sshCaEnrolled`,
   * two keys nothing in this repository ever writes.
   */

  @Get(':id')
  @ApiOperation({
    summary: 'Get cluster details',
    description:
      'Returns detailed information about a specific cluster. ' +
      'Use include_real_status=true to get real-time server status from cloud provider.',
  })
  @ApiParam({
    name: 'id',
    description: 'Cluster ID',
    example: 'uuid-cluster-id',
  })
  @ApiQuery({
    name: 'include_real_status',
    required: false,
    type: Boolean,
    description:
      'Include real-time server status from cloud provider (default: false)',
    example: false,
  })
  @ApiResponse({
    status: 200,
    description: 'Cluster details',
    type: ClusterResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async getCluster(
    @Param('id') id: string,
    @Query('include_real_status') includeRealStatus?: string,
  ): Promise<ClusterResponseDto> {
    const shouldIncludeRealStatus = includeRealStatus === 'true';
    return this.clustersService.getCluster(id, shouldIncludeRealStatus);
  }

  /*
   * There is no `GET :id/kubeconfig`. A kubeconfig is the key to the whole
   * cluster, and it is deliberately not downloadable by anyone — not even an
   * administrator. It exists for cluster-to-cluster traffic only, which reads it
   * in-process through `ClustersService.getKubeconfig()`.
   */

  @Get(':id/capacity-plan')
  @RequireSection('infrastructure')
  @ApiOperation({
    summary: 'Get cluster master capacity & resize candidates',
    description:
      'Returns the master node current allocatable/used/free capacity, the ' +
      'current server type and a sorted list of upgrade/downgrade candidates ' +
      'with monthly cost delta. Used by `flui env capacity` to plan ' +
      '`scale-master` and `storage expand` operations for dedicated apps.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiResponse({ status: 200, type: ClusterCapacityPlanDto })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async getClusterCapacityPlan(
    @Param('id') id: string,
  ): Promise<ClusterCapacityPlanDto> {
    return this.clusterCapacityService.getPlan(id);
  }

  @Get(':id/nodes/:nodeId/scale/preview')
  @RequireSection('infrastructure')
  @ApiOperation({
    summary: 'Preview impact of a scale-node operation',
    description:
      'Returns the current server type, affected dedicated workloads and ' +
      'expected downtime for a vertical scale of the named node. Use this ' +
      'before invoking POST .../scale to confirm the maintenance window.',
  })
  async previewScaleNode(
    @Param('id') id: string,
    @Param('nodeId') nodeId: string,
  ) {
    return this.clusterNodeScalingService.previewScaleNode(id, nodeId);
  }

  @Post(':id/nodes/:nodeId/uncordon')
  @RequireSection('infrastructure')
  @ActionCycle({
    action: 'POST /infrastructure/clusters/:id/nodes/:nodeId/uncordon',
    bind: ['id', 'nodeId'],
    sentence: 'make node {nodeId} of cluster {id} schedulable again',
    consequence:
      'Workloads start being placed on that node again, including ones that moved off it.',
  })
  @ApiOperation({
    summary: 'Mark a cluster node schedulable again',
    description:
      'Recovery helper. Useful if a scale-node operation interrupted before ' +
      'reaching the uncordon step.',
  })
  async uncordonNode(
    @Param('id') id: string,
    @Param('nodeId') nodeId: string,
  ): Promise<{ ok: true }> {
    await this.clusterNodeScalingService.uncordonNode(id, nodeId);
    return { ok: true };
  }

  @Post(':id/nodes/:nodeId/scale')
  @RequireSection('infrastructure')
  // The preview route is the estimate, and it is the one in this file that
  // prices something other than money: it names the dedicated workloads that go
  // down and for how long.
  @ActionCycle({
    action: 'POST /infrastructure/clusters/:id/nodes/:nodeId/scale',
    bind: ['id', 'nodeId'],
    sentence:
      'resize node {nodeId} of cluster {id}, taking it down while it runs',
    estimate: '/infrastructure/clusters/:id/nodes/:nodeId/scale/preview',
  })
  @ApiOperation({
    summary:
      'Vertically scale a cluster node (power-off → change_type → power-on)',
    description:
      'Maintenance-window operation. Cordons the node, powers it off, asks the ' +
      'provider to change its server type, powers it back on and waits for ' +
      'k3s to report Ready. Total downtime ~3–5 min. All pods scheduled on ' +
      'the node — including dedicated databases — are unavailable during ' +
      'this window. Snapshot DBs first.',
  })
  @ApiResponse({
    status: 200,
    description: 'Operation completed successfully',
  })
  async scaleNode(
    @Param('id') id: string,
    @Param('nodeId') nodeId: string,
    @Body() body: ScaleNodeDto,
  ) {
    return this.clusterNodeScalingService.scaleNode(id, nodeId, body);
  }

  @Post(':id/storage/expand')
  @RequireSection('infrastructure')
  // A volume never shrinks again, so the sentence says "grow" and the estimate
  // is the current size: approving this without knowing what it is today is
  // approving an unbounded number.
  @ActionCycle({
    action: 'POST /infrastructure/clusters/:id/storage/expand',
    bind: ['id'],
    sentence:
      'grow the shared storage of cluster {id}, which can never shrink back',
    // No estimate: `GET .../storage` reports the storage in use now, which is
    // not what expanding it will cost.
    consequence: 'The cluster volume grows and cannot be shrunk again.',
  })
  @ApiOperation({
    summary: 'Expand the cluster shared-storage backing volume',
    description:
      'Resizes the Flui-managed Volume on the provider, then runs `resize2fs` ' +
      'over SSH on the master so the new space is usable. Online for ext4 — ' +
      'no downtime expected.',
  })
  async expandSharedVolume(
    @Param('id') id: string,
    @Body() body: ExpandSharedVolumeDto,
  ) {
    return this.clusterNodeScalingService.expandSharedVolume(id, body);
  }

  @Get(':id/storage')
  @RequireSection('clusters')
  @ApiOperation({
    summary: 'Get cluster shared-storage status',
    description:
      'Returns the configuration and live runtime status of the Flui shared storage layer ' +
      '(NFS+fscache, see scaling doc §14): backing Volume, NFS export, and PVC summary.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiResponse({ status: 200, type: ClusterStorageStatusDto })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async getClusterStorage(
    @Param('id') id: string,
  ): Promise<ClusterStorageStatusDto> {
    return this.clusterStorageService.getStatus(id);
  }

  @Get(':id/nodes')
  @ApiOperation({
    summary: 'Get cluster nodes',
    description:
      'Returns all nodes in the cluster, each with the shape it actually is: ' +
      'provider, region, serverType and hourlyPriceEur. The last three are null ' +
      'where the provider records no such thing — a BYOS machine is the ' +
      "operator's own, so a null price means no price is known, never free.",
  })
  @ApiParam({
    name: 'id',
    description: 'Cluster ID',
  })
  @ApiResponse({
    status: 200,
    description: 'List of cluster nodes',
  })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async getClusterNodes(@Param('id') id: string) {
    const nodes = await this.clustersService.getClusterNodes(id);
    return nodes.map((n) => ({
      id: n.id,
      serverName: n.serverName,
      nodeType: n.nodeType,
      ipAddress: n.ipAddress,
      status: n.status,
      providerResourceId: n.providerResourceId,
      provider: n.provider,
      region: n.region ?? null,
      serverType: n.serverType ?? null,
      hourlyPriceEur: n.hourlyPriceEur ?? null,
      createdAt: n.createdAt,
      metadata: n.metadata,
    }));
  }

  @Get(':id/billing')
  @RequireSection('clusters')
  @ApiOperation({
    summary: 'Get cluster billing information',
    description:
      'Returns billing information for a specific cluster including per-node cost breakdown, ' +
      'traffic consumption, and current billing period costs calculated from real-time provider pricing.',
  })
  @ApiParam({
    name: 'id',
    description: 'Cluster ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Cluster billing information',
    type: ClusterBillingResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  @ApiResponse({
    status: 400,
    description: 'Billing not supported for this provider',
  })
  async getClusterBilling(
    @Param('id') id: string,
  ): Promise<ClusterBillingResponseDto> {
    return this.clusterBillingService.getClusterBilling(id);
  }

  @Patch(':id/metadata')
  @RequireSection('infrastructure')
  @ApiOperation({
    summary: 'Update cluster metadata',
    description:
      'Merges new metadata with existing cluster metadata. ' +
      'If isControlCluster (legacy: isObservabilityCluster) is set, the cluster type will be automatically adjusted.',
  })
  @ApiParam({
    name: 'id',
    description: 'Cluster ID',
    example: 'uuid-cluster-id',
  })
  @ApiBody({ type: UpdateClusterMetadataDto })
  @ApiResponse({
    status: 200,
    description: 'Cluster metadata updated successfully',
    type: ClusterResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async updateClusterMetadata(
    @Param('id') clusterId: string,
    @Body() dto: UpdateClusterMetadataDto,
  ): Promise<ClusterResponseDto> {
    return this.clustersService.updateClusterMetadata(clusterId, dto.metadata);
  }

  @Patch(':clusterId/nodes/:nodeId/metadata')
  @RequireSection('infrastructure')
  @ApiOperation({
    summary: 'Update node metadata',
    description: 'Merges new metadata with existing node metadata.',
  })
  @ApiParam({
    name: 'clusterId',
    description: 'Cluster ID',
    example: 'uuid-cluster-id',
  })
  @ApiParam({
    name: 'nodeId',
    description: 'Node ID',
    example: 'uuid-node-id',
  })
  @ApiBody({ type: UpdateNodeMetadataDto })
  @ApiResponse({
    status: 200,
    description: 'Node metadata updated successfully',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        serverName: { type: 'string' },
        nodeType: { type: 'string', enum: ['master', 'worker'] },
        ipAddress: { type: 'string' },
        status: { type: 'string' },
        metadata: { type: 'object' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Cluster or node not found' })
  async updateNodeMetadata(
    @Param('clusterId') clusterId: string,
    @Param('nodeId') nodeId: string,
    @Body() dto: UpdateNodeMetadataDto,
  ) {
    const node = await this.clustersService.updateNodeMetadata(
      clusterId,
      nodeId,
      dto.metadata,
    );
    return {
      id: node.id,
      serverName: node.serverName,
      nodeType: node.nodeType,
      ipAddress: node.ipAddress,
      status: node.status,
      metadata: node.metadata,
      createdAt: node.createdAt,
    };
  }

  // The only route in the product that carries `cluster:destroy`. The section
  // says *which area*; this says *how deep*, and deleting a cluster is the most
  // destructive act Flui has. `stop`/`start` deliberately do not carry it: they
  // are reversible, and a name that says "destroy" over a reversible action is a
  // name that lies.
  @Delete(':id')
  @RequireSection('infrastructure')
  @RequirePermission(IAM_PERMISSION.CLUSTER_DESTROY)
  @ApiOperation({
    summary: 'Delete a cluster',
    description:
      'Initiates cluster deletion. All nodes will be deleted from the cloud provider. ' +
      'Validates Flui ownership before deletion unless force=true.',
  })
  @ApiParam({
    name: 'id',
    description: 'Cluster ID',
    example: 'uuid-cluster-id',
  })
  @ApiQuery({
    name: 'force',
    required: false,
    type: Boolean,
    description:
      'Force deletion without ownership validation (use with caution)',
    example: false,
  })
  @ApiResponse({
    status: 202,
    description: 'Cluster deletion queued',
    schema: {
      type: 'object',
      properties: {
        operation_id: { type: 'string' },
        status: { type: 'string' },
        estimated_duration: { type: 'string' },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  @ApiResponse({
    status: 400,
    description: 'Cluster already deleting/deleted',
  })
  async deleteCluster(
    @Param('id') id: string,
    @Query('force') force?: string,
  ): Promise<{
    operation_id: string;
    status: string;
    estimated_duration: string;
  }> {
    const forceDelete = force === 'true' || force === '1';
    const operation = await this.clustersService.deleteCluster(id, forceDelete);

    return {
      operation_id: operation.id,
      status: operation.status,
      estimated_duration: operation.metadata?.estimatedDurationInSeconds
        ? `${Math.round(operation.metadata.estimatedDurationInSeconds / 60)} minutes`
        : '5-10 minutes',
    };
  }

  /**
   * Get firewall for a cluster
   */
  @Get(':id/firewall')
  @RequireSection('firewall')
  @ApiOperation({
    summary: 'Get cluster firewall',
    description: 'Retrieve the firewall configuration for a specific cluster',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiResponse({
    status: 200,
    description: 'Cluster firewall details',
    type: ProviderFirewallDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Cluster or firewall not found',
  })
  async getClusterFirewall(
    @Param('id') clusterId: string,
  ): Promise<ProviderFirewallDto> {
    const firewall =
      await this.firewallsService.getFirewallByClusterId(clusterId);

    if (!firewall) {
      throw new Error(`No firewall found for cluster ${clusterId}`);
    }

    return {
      id: firewall.id,
      name: firewall.name,
      provider: firewall.provider,
      rules: firewall.rules,
      appliedToServerCount: firewall.appliedToServerIds?.length || 0,
      labels: firewall.labels,
      createdAt: firewall.createdAt,
      updatedAt: firewall.updatedAt,
    };
  }

  @Post(':id/reconcile-tags')
  @RequireSection('infrastructure')
  @ApiOperation({
    summary: 'Reconcile tags and optionally firewalls for registered cluster',
    description:
      'Finds registered cluster nodes on the cloud provider and applies proper Flui tags. ' +
      'By default, also reconciles firewall attachments by discovering existing firewalls and creating attachment records. ' +
      'This is useful for clusters registered without automatic tagging or for fixing inconsistencies. ' +
      'The operation will find servers by name or IP address, update their providerResourceId if needed, ' +
      'apply all required Flui labels (flui-cluster-id, flui-node-id, managed-by, etc.), ' +
      'and optionally discover and link existing firewalls to templates. ' +
      'Set includeFirewalls=false to skip firewall reconciliation.',
  })
  @ApiParam({
    name: 'id',
    description: 'Cluster ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({ type: ReconcileTagsDto })
  @ApiResponse({
    status: 200,
    description: 'Tag reconciliation completed',
    type: ReconcileTagsResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Cluster not found',
  })
  async reconcileClusterTags(
    @Param('id') clusterId: string,
    @Body() dto: ReconcileTagsDto,
  ): Promise<ReconcileTagsResponseDto> {
    return this.clustersService.reconcileClusterTags(
      clusterId,
      dto.force || false,
      dto.includeFirewalls !== false, // Default to true
    );
  }

  @Post(':id/reconcile-firewalls')
  @RequireSection('infrastructure')
  @ApiOperation({
    summary: 'Reconcile firewall attachments for registered cluster',
    description:
      'Discovers existing firewalls on the cloud provider and creates firewall attachment records in the database. ' +
      'This makes registered cluster firewalls visible in the firewall-attachments endpoint. ' +
      'Optionally matches discovered firewalls to existing templates by comparing rules. ' +
      'Useful for clusters registered via CLI or external tools where firewall attachments were not created.',
  })
  @ApiParam({
    name: 'id',
    description: 'Cluster ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({ type: ReconcileFirewallsDto })
  @ApiResponse({
    status: 200,
    description: 'Firewall reconciliation completed',
    type: ReconcileFirewallsResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Cluster not found',
  })
  async reconcileClusterFirewalls(
    @Param('id') clusterId: string,
    @Body() dto: ReconcileFirewallsDto,
  ): Promise<ReconcileFirewallsResponseDto> {
    return this.clustersService.reconcileClusterFirewalls(clusterId, {
      force: dto.force || false,
      autoMatchTemplates: dto.autoMatchTemplates !== false, // Default to true
    });
  }

  @Post(':id/stop')
  @RequireSection('infrastructure')
  // Reversible, and still the widest blast radius in this file: everything on
  // the cluster goes dark. The estimate is the bill, because saving it is the
  // only reason anybody does this.
  @ActionCycle({
    action: 'POST /infrastructure/clusters/:id/stop',
    bind: ['id'],
    sentence:
      'power off every server of cluster {id}, taking everything on it offline',
    // No estimate: `GET .../billing` is the current period's spend, and what
    // this action changes about the bill depends on the provider — some keep
    // charging for a stopped server. Saying "it has a price you cannot see"
    // was the wrong half of that.
    consequence:
      'Every application on the cluster stops answering until somebody powers it back on.',
  })
  @ApiOperation({
    summary: 'Stop all cluster servers (async)',
    description:
      'Initiates asynchronous power-off of all servers in the cluster to save costs while preserving data. ' +
      'Returns an operation ID for tracking. All data (volumes, configurations) is preserved. ' +
      'Estimated cost savings: ~92% per server (~6.90€/month per node). ' +
      'Expected duration: 2-5 minutes.',
  })
  @ApiParam({
    name: 'id',
    description: 'Cluster ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 202,
    description: 'Cluster stop operation queued',
    type: ClusterPowerOperationResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Cluster not found',
  })
  @ApiResponse({
    status: 400,
    description:
      'Invalid request (e.g., cluster has no nodes, provider does not support power management)',
  })
  async stopCluster(
    @Param('id') clusterId: string,
  ): Promise<ClusterPowerOperationResponseDto> {
    return this.clustersService.stopCluster(clusterId);
  }

  @Post(':id/start')
  @RequireSection('infrastructure')
  @ActionCycle({
    action: 'POST /infrastructure/clusters/:id/start',
    bind: ['id'],
    sentence: 'power the servers of cluster {id} back on',
    // No estimate, for the same reason as powering off.
    consequence:
      'The servers boot and start being charged again; applications come back as their nodes rejoin.',
  })
  @ApiOperation({
    summary: 'Start all cluster servers (async)',
    description:
      'Initiates asynchronous power-on of all servers in the cluster that were previously stopped. ' +
      'Returns an operation ID for tracking. Servers may take 2-5 minutes to boot and become fully operational. ' +
      'Expected duration: 2-5 minutes.',
  })
  @ApiParam({
    name: 'id',
    description: 'Cluster ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 202,
    description: 'Cluster start operation queued',
    type: ClusterPowerOperationResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Cluster not found',
  })
  @ApiResponse({
    status: 400,
    description:
      'Invalid request (e.g., cluster has no nodes, provider does not support power management)',
  })
  async startCluster(
    @Param('id') clusterId: string,
  ): Promise<ClusterPowerOperationResponseDto> {
    return this.clustersService.startCluster(clusterId);
  }

  @Post(':id/reconcile-status')
  @RequireSection('infrastructure')
  @ApiOperation({
    summary: 'Reconcile cluster status with real provider state',
    description:
      'Checks the real-time status of all cluster servers on the cloud provider and ' +
      'updates the cluster status in the database to match reality. ' +
      'This is useful when servers are stopped/started manually outside of Flui. ' +
      'With autoFix=true, will also align server states to match the desired cluster status.',
  })
  @ApiParam({
    name: 'id',
    description: 'Cluster ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({
    type: ReconcileStatusDto,
    required: false,
    description: 'Optional configuration for reconciliation',
  })
  @ApiResponse({
    status: 200,
    description: 'Status reconciliation completed',
    type: ReconcileStatusResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Cluster not found',
  })
  @ApiResponse({
    status: 400,
    description:
      'Invalid request (e.g., cluster has no nodes, provider does not support power management)',
  })
  async reconcileClusterStatus(
    @Param('id') clusterId: string,
    @Body() dto?: ReconcileStatusDto,
  ): Promise<ReconcileStatusResponseDto> {
    return this.clustersService.reconcileClusterStatus(
      clusterId,
      dto?.autoFix || false,
    );
  }

  @Post(':id/refresh-grafana')
  @RequireSection('infrastructure')
  @ApiOperation({
    summary: 'Refresh Grafana datasources after IP change',
    description:
      'Manually refresh Grafana datasources for a workload cluster. ' +
      'Useful when cluster IP changes after stop/start or node recreation. ' +
      'This endpoint removes and re-adds the cluster datasources in Grafana with updated IPs.',
  })
  @ApiParam({
    name: 'id',
    description: 'Cluster ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Grafana datasources refreshed successfully',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'Grafana datasources refreshed' },
        clusterId: { type: 'string' },
        clusterName: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Cluster not found',
  })
  @ApiResponse({
    status: 400,
    description: 'Cluster is not a workload cluster or operation failed',
  })
  async refreshGrafanaDatasources(
    @Param('id') clusterId: string,
  ): Promise<{ message: string; clusterId: string; clusterName: string }> {
    // Get cluster details
    const clusterDto = await this.clustersService.getCluster(clusterId);

    // Validate cluster type
    if (clusterDto.clusterType !== ClusterType.WORKLOAD) {
      throw new Error(
        `Cluster ${clusterDto.name} is not a workload cluster (type: ${clusterDto.clusterType}). ` +
          'Only workload clusters can have datasources refreshed.',
      );
    }

    // Validate cluster is READY (status is lowercase in DTO)
    if (clusterDto.status !== 'ready') {
      throw new Error(
        `Cluster ${clusterDto.name} is not ready (status: ${clusterDto.status}). ` +
          'Cluster must be in READY status to refresh Grafana datasources.',
      );
    }

    // Get full cluster entity for service call
    const cluster = await this.clustersService['clusterRepository'].findOne({
      where: { id: clusterId },
    });

    if (!cluster) {
      throw new Error(`Cluster ${clusterId} not found`);
    }

    // Remove old datasources
    await this.grafanaDatasourceService.removeClusterDatasources(clusterId);

    // Add datasources with current IPs
    await this.grafanaDatasourceService.addClusterDatasources(cluster);

    return {
      message: 'Grafana datasources refreshed successfully',
      clusterId: cluster.id,
      clusterName: cluster.name,
    };
  }

  @Get(':id/resource-availability')
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'Check cluster resource availability',
    description:
      'Checks if the cluster has sufficient CPU and memory to deploy a new application. ' +
      'Uses live K8s node allocatable data with a 10% safety margin. ' +
      'Pass either a profile name or custom cpuRequest/memoryRequest values.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiQuery({
    name: 'profile',
    required: false,
    description:
      'Resource profile name (nano | small | medium | large | xlarge)',
    example: 'medium',
  })
  @ApiQuery({
    name: 'cpuRequest',
    required: false,
    description:
      'Custom CPU request in millicores (e.g. 300 for 300m). Used when profile is not specified.',
    example: 300,
  })
  @ApiQuery({
    name: 'memoryRequest',
    required: false,
    description:
      'Custom memory request in Mi (e.g. 512 for 512Mi). Used when profile is not specified.',
    example: 512,
  })
  @ApiQuery({
    name: 'replicas',
    required: false,
    type: Number,
    description: 'Number of replicas (default: 1)',
    example: 1,
  })
  @ApiResponse({ status: 200, type: ResourceAvailabilityResponseDto })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async checkResourceAvailability(
    @Param('id') clusterId: string,
    @Query('profile') profile?: string,
    @Query('cpuRequest') cpuRequest?: string,
    @Query('memoryRequest') memoryRequest?: string,
    @Query('replicas') replicas?: string,
  ): Promise<ResourceAvailabilityResponseDto> {
    const replicaCount = Math.max(Number.parseInt(replicas || '1', 10) || 1, 1);

    let cpuMc: number;
    let memMi: number;
    let profileName: string | null = null;

    if (profile) {
      const allProfiles = this.resourceProfilesService.getProfiles().profiles;
      const resolved = allProfiles.find((p) => p.name === profile);
      if (resolved) {
        cpuMc = this.kubernetesService.parseCpu(resolved.cpu.request);
        memMi = this.kubernetesService.parseMemory(resolved.memory.request);
        profileName = resolved.name;
      } else {
        // Unknown profile — fall back to default
        const def = this.resourceProfilesService.resolveResources(
          this.resourceProfilesService.getDefaultProfileName(),
        );
        cpuMc = this.kubernetesService.parseCpu(def.cpu.request);
        memMi = this.kubernetesService.parseMemory(def.memory.request);
        profileName = def.name;
      }
    } else {
      cpuMc = Number.parseInt(cpuRequest || '100', 10) || 100;
      memMi = Number.parseInt(memoryRequest || '128', 10) || 128;
    }

    return this.clustersService.checkResourceAvailability(
      clusterId,
      cpuMc,
      memMi,
      replicaCount,
      profileName,
    );
  }

  @Get(':id/build-resources')
  @RequireSection('infrastructure')
  @ApiOperation({
    summary: 'Check cluster resource availability for a build job',
    description:
      'Returns whether the cluster has enough resources to run a build job. ' +
      'status: ok | autoscaling_required | insufficient',
  })
  @ApiResponse({ status: 200, type: BuildResourcesResponseDto })
  async getBuildResources(
    @Param('id') clusterId: string,
  ): Promise<BuildResourcesResponseDto> {
    return this.clustersService.getBuildResources(clusterId);
  }
}

/** Undefined rather than NaN for anything unparseable, so a typo falls back to the default. */
function parsePositive(raw?: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
