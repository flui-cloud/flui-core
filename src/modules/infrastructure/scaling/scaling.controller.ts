import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import {
  SCALING_CONSEQUENCE,
  scalingConsequenceClause,
} from './scaling-consequence';
import { ScalingGroupService } from './services/scaling-group.service';
import { ScalingOverviewService } from './services/scaling-overview.service';
import {
  EditScalingGroupDto,
  WriteScalingGroupDto,
} from './dto/scaling-group.dto';
import {
  ClusterScalingDecisionDto,
  ClusterScalingRowDto,
  ScalingDecisionResponseDto,
  ScalingGroupResponseDto,
} from './dto/scaling-response.dto';
import { ShapeOrderingService } from './catalogue/shape-ordering.service';
import { ScalingEngineService } from './engine/scaling-engine.service';
import { ScalingPreviewDto } from './dto/scaling-preview.dto';
import { ShapeCatalogueDto } from './catalogue/dto/shape-catalogue.dto';

/** Said the same way on every route that can answer it, so a caller reads one string. */
const CLUSTER_ID = 'Cluster ID';
const GROUP_ID = 'Scaling group ID';
const CLUSTER_MISSING = {
  status: 404,
  description: 'Cluster not found — body carries code `CLUSTER_NOT_FOUND`',
};
const GROUP_MISSING = {
  status: 404,
  description:
    'Scaling group not found — body carries code `SCALING_GROUP_NOT_FOUND`',
};

/**
 * Reads ask for `cluster:read` and writes for `cluster:manage`, on every route.
 *
 * Not `scale:execute`, which reads like the obvious name and is not: it already
 * governs what an application does with its own replicas, and one permission
 * covering both would let a credential minted to restart an application buy a
 * server.
 *
 * The section is `clusters` rather than `infrastructure`, which is where the
 * autoscale status already sits: `infrastructure` opens on `cluster:manage` at
 * global scope, so gating the reads there would demand management of anyone who
 * only wants to look.
 *
 * Every refusal below carries a `code` (see `scaling-errors.ts`), because 404 on
 * this surface is three answers: a route this build does not serve, a cluster
 * that is not there, and a group that is not there. Nest answers the first
 * itself and puts no code in it, so a 404 with no code is the missing route.
 */
@ApiTags('Infrastructure - Scaling')
@ApiBearerAuth()
@Controller('infrastructure')
@RequireSection('clusters')
export class ScalingController {
  constructor(
    private readonly groups: ScalingGroupService,
    private readonly overview: ScalingOverviewService,
    private readonly ordering: ShapeOrderingService,
    private readonly engine: ScalingEngineService,
  ) {}

  @Get('scaling')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'One scaling row per cluster',
    description:
      'Includes clusters with no scaling group and clusters that can only raise an alarm — the two cases a filter would hide precisely when somebody is needed.',
  })
  @ApiResponse({ status: 200, type: [ClusterScalingRowDto] })
  async rows(): Promise<ClusterScalingRowDto[]> {
    return this.overview.rows();
  }

  @Get('clusters/:clusterId/scaling')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({ summary: 'The scaling row of one cluster' })
  @ApiParam({ name: 'clusterId', description: CLUSTER_ID })
  @ApiResponse({ status: 200, type: ClusterScalingRowDto })
  @ApiResponse(CLUSTER_MISSING)
  async row(
    @Param('clusterId') clusterId: string,
  ): Promise<ClusterScalingRowDto> {
    return this.overview.rowFor(clusterId);
  }

  /**
   * The question is asked of a cluster, so it is answered by one.
   *
   * Nobody asks an autoscaler what is configured; they ask why nothing happened.
   * Reaching that answer through a group means a cluster with two groups makes
   * somebody choose one before they may find out — and choosing wrong answers
   * about the wrong fleet.
   */
  @Get('clusters/:clusterId/scaling-decisions')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'What was last decided on this cluster, by any of its groups',
    description:
      'Newest first, across every group the cluster holds, each row naming the group that decided it. The declines are the answer: they say why nothing happened, which is the only question an autoscaler is ever asked.',
  })
  @ApiParam({ name: 'clusterId', description: CLUSTER_ID })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiResponse({ status: 200, type: [ClusterScalingDecisionDto] })
  @ApiResponse(CLUSTER_MISSING)
  async clusterDecisions(
    @Param('clusterId') clusterId: string,
    @Query('limit') limit?: string,
  ): Promise<ClusterScalingDecisionDto[]> {
    return this.groups.decisionsOfCluster(clusterId, parseLimit(limit));
  }

  @Get('clusters/:clusterId/scaling-groups')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'The scaling groups of a cluster',
    description:
      'A cluster may hold more than one — one for the general work, one for the heavy jobs.',
  })
  @ApiParam({ name: 'clusterId', description: CLUSTER_ID })
  @ApiResponse({ status: 200, type: [ScalingGroupResponseDto] })
  @ApiResponse(CLUSTER_MISSING)
  async list(
    @Param('clusterId') clusterId: string,
  ): Promise<ScalingGroupResponseDto[]> {
    return this.groups.listForCluster(clusterId);
  }

  @Post('clusters/:clusterId/scaling-groups')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  // What is being agreed to is not a node, it is a standing figure: how large
  // this cluster may become and how much of somebody's money it may spend with
  // nobody in the room. The clause reads that figure off the body, so the
  // question a person answers carries the number rather than the word "scaling".
  @ActionCycle({
    action: 'POST /infrastructure/clusters/:clusterId/scaling-groups',
    bind: ['clusterId'],
    sentence: 'let cluster {clusterId} decide its own size and spend',
    clause: scalingConsequenceClause,
    consequence: SCALING_CONSEQUENCE,
  })
  @ApiOperation({
    summary: 'Write a scaling group',
    description:
      'Nothing acts on it: the group is stored, read back and previewed. Refused when it promises what the provider cannot do — buying where there is no create API, or naming a shape where no catalogue publishes one.',
  })
  @ApiParam({ name: 'clusterId', description: CLUSTER_ID })
  @ApiResponse({ status: 201, type: ScalingGroupResponseDto })
  @ApiResponse({
    status: 400,
    description: 'The group says something the provider cannot do',
  })
  @ApiResponse(CLUSTER_MISSING)
  @ApiResponse({
    status: 409,
    description:
      'The cluster already has a group with that name — body carries code `SCALING_GROUP_NAME_TAKEN`',
  })
  async create(
    @Param('clusterId') clusterId: string,
    @Body() dto: WriteScalingGroupDto,
  ): Promise<ScalingGroupResponseDto> {
    return this.groups.create(clusterId, dto);
  }

  @Get('scaling-groups/:id')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({ summary: 'One scaling group' })
  @ApiParam({ name: 'id', description: GROUP_ID })
  @ApiResponse({ status: 200, type: ScalingGroupResponseDto })
  @ApiResponse(GROUP_MISSING)
  async get(@Param('id') id: string): Promise<ScalingGroupResponseDto> {
    return this.groups.get(id);
  }

  @Patch('scaling-groups/:id')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  // Raising a ceiling is the same act as writing one, so it meets the same
  // question. A body that restates neither the bounds nor the limits leaves the
  // clause silent, and the sentence stays what it was.
  @ActionCycle({
    action: 'PATCH /infrastructure/scaling-groups/:id',
    bind: ['id'],
    sentence: 'change what scaling group {id} may grow to and spend',
    clause: scalingConsequenceClause,
    consequence: SCALING_CONSEQUENCE,
  })
  @ApiOperation({
    summary: 'Change a scaling group',
    description:
      'Every field present is replaced whole, and present is the test rather than truthy: the three bounds are three roles that only mean anything together, the limits are the same, and `regions: []`, `shapes: []`, `standingOrders: []` and `settleSeconds: 0` all land as sent. Leaving a field out is the only way to keep what is stored, and it is how a block is emptied — a body that says nothing about the limits keeps them, one that sends `limits` without `maxMonthlyCost` removes the ceiling.',
  })
  @ApiParam({ name: 'id', description: GROUP_ID })
  @ApiResponse({ status: 200, type: ScalingGroupResponseDto })
  @ApiResponse(GROUP_MISSING)
  async update(
    @Param('id') id: string,
    @Body() dto: EditScalingGroupDto,
  ): Promise<ScalingGroupResponseDto> {
    return this.groups.update(id, dto);
  }

  @Delete('scaling-groups/:id')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a scaling group and the decisions it took',
    description:
      'Removes no node and stops no machine: nothing runs off this group yet.',
  })
  @ApiParam({ name: 'id', description: GROUP_ID })
  @ApiResponse({ status: 204, description: 'Removed' })
  @ApiResponse(GROUP_MISSING)
  async remove(@Param('id') id: string): Promise<void> {
    return this.groups.remove(id);
  }

  @Get('scaling-groups/:id/catalogue')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'The shapes this group could buy, ordered by what the market says',
    description:
      'Orders and never decides: nothing is dropped, the provider still accepts or refuses at the moment of purchase, and shapes the group may not buy are listed and marked. Carries the age of the reading, and says which of the six reasons produced it — an unread catalogue narrows nothing.',
  })
  @ApiParam({ name: 'id', description: GROUP_ID })
  @ApiResponse({ status: 200, type: ShapeCatalogueDto })
  @ApiResponse(GROUP_MISSING)
  async catalogue(@Param('id') id: string): Promise<ShapeCatalogueDto> {
    return this.ordering.order(await this.groups.get(id));
  }

  @Get('scaling-groups/:id/preview')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'What this group would do if a node were needed right now',
    description:
      'The same engine the reconciler runs, on demand and spending nothing. The ladder is walked in full and every rung that loses says why — including the one case that reads like an outage and is a setting: a shape that is available and affordable and refused by the group’s own rules.',
  })
  @ApiParam({ name: 'id', description: GROUP_ID })
  @ApiResponse({ status: 200, type: ScalingPreviewDto })
  @ApiResponse(GROUP_MISSING)
  async preview(@Param('id') id: string): Promise<ScalingPreviewDto> {
    return this.engine.preview(id);
  }

  @Get('scaling-groups/:id/decisions')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'What this group decided, and what it declined to decide',
    description:
      'Newest first. The declines carry the whole answer to the only question anybody asks an autoscaler.',
  })
  @ApiParam({ name: 'id', description: GROUP_ID })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiResponse({ status: 200, type: [ScalingDecisionResponseDto] })
  @ApiResponse(GROUP_MISSING)
  async decisions(
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ): Promise<ScalingDecisionResponseDto[]> {
    return this.groups.decisionsOf(id, parseLimit(limit));
  }
}

function parseLimit(limit?: string): number | undefined {
  const parsed = limit ? Number(limit) : undefined;
  return Number.isFinite(parsed) ? (parsed as number) : undefined;
}
