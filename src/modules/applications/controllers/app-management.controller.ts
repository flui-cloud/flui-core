import {
  Controller,
  Get,
  Patch,
  Post,
  Put,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { AppManagementService } from '../services/app-management.service';
import { AppAccessGuard, AppAction } from '../guards/app-access.guard';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import {
  UpdateResourcesDto,
  UpdateReplicasDto,
  UpdateAutoscalingDto,
  AppAutoscalingDto,
  AppRuntimeResponseDto,
  ResourcesConsequenceDto,
} from '../dto/app-management.dto';
import { AppResourcesConsequenceService } from '../services/app-resources-consequence.service';
import { AppAutoscalingService } from '../services/app-autoscaling.service';
import { AppAvailabilityService } from '../services/app-availability.service';
import { AppAvailabilityResponseDto } from '../dto/app-availability.dto';

@ApiTags('Application Management')
@ApiBearerAuth()
@Controller('applications/:appId')
// Every route here names one application and three of the four change it. The
// guard reads `:appId` as well as `:id`, so mounting it on the class is the
// whole gate: GET asks app:read, and each write says which permission it means.
//
// Two of them mean `scale:execute`, not `app:write`. Changing how many copies
// run, or replacing the running ones, touches no configuration and no secret —
// it is the runbook half of operating an application, and the credential a
// runbook or an agent should carry for it is "can restart and scale, cannot
// touch variables". Deriving `app:write` from the verb made that credential
// impossible to describe. `resources` stays `app:write` on purpose: CPU and
// memory limits are configuration.
@UseGuards(AppAccessGuard)
export class AppManagementController {
  constructor(
    private readonly appManagementService: AppManagementService,
    private readonly consequence: AppResourcesConsequenceService,
    private readonly autoscaling: AppAutoscalingService,
    private readonly availability: AppAvailabilityService,
  ) {}

  @Get('availability')
  @ApiOperation({
    summary: 'Whether the application survives losing a worker',
    description:
      'Highly available when at least two copies run on different nodes, its volumes are not tied to one node, its addresses use a real domain and more than one node takes traffic. Otherwise every reason, each with what to change.',
  })
  @ApiParam({ name: 'appId', description: 'Application ID' })
  @ApiResponse({ status: 200, type: AppAvailabilityResponseDto })
  async getAvailability(
    @Param('appId') appId: string,
  ): Promise<AppAvailabilityResponseDto> {
    return this.availability.forApplication(appId);
  }

  @Get('runtime')
  @ApiOperation({
    summary: 'Get live runtime status',
    description:
      'Returns live replica counts, container CPU/memory specs and current usage from the cluster.',
  })
  @ApiParam({ name: 'appId', description: 'Application ID' })
  @ApiResponse({ status: 200, type: AppRuntimeResponseDto })
  async getRuntimeStatus(
    @Param('appId') appId: string,
  ): Promise<AppRuntimeResponseDto> {
    return this.appManagementService.getRuntimeStatus(appId);
  }

  @Patch('resources')
  @ApiOperation({
    summary: 'Update CPU / memory resources',
    description:
      'Patches the Deployment resource requests and/or limits for the specified container (defaults to the first container). ' +
      'Only the provided fields are updated; omitted fields are left unchanged.',
  })
  @ApiParam({ name: 'appId', description: 'Application ID' })
  @ApiResponse({ status: 200, type: AppRuntimeResponseDto })
  async updateResources(
    @Param('appId') appId: string,
    @Body() dto: UpdateResourcesDto,
  ): Promise<AppRuntimeResponseDto> {
    return this.appManagementService.updateResources(appId, dto);
  }

  @Post('resources/consequence')
  @AppAction(IAM_PERMISSION.APP_READ)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'What a resource change would do, before it is written',
    description:
      'Takes the same body as PATCH resources and writes nothing: the values as they would be stored, whether they would be refused, and where the replicas would run — on a node already there, on a machine a scaling group would buy or propose, or nowhere yet.',
  })
  @ApiParam({ name: 'appId', description: 'Application ID' })
  @ApiResponse({ status: 200, type: ResourcesConsequenceDto })
  @ApiResponse({ status: 400, description: 'Not a CPU or memory quantity' })
  async resourcesConsequence(
    @Param('appId') appId: string,
    @Body() dto: UpdateResourcesDto,
  ): Promise<ResourcesConsequenceDto> {
    return this.consequence.consequenceOf(appId, dto);
  }

  @Patch('replicas')
  @AppAction(IAM_PERMISSION.SCALE_EXECUTE)
  @ApiOperation({
    summary: 'Scale replica count',
    description:
      'Sets the desired replica count on the Deployment. Use 0 to stop all pods without deleting the workload.',
  })
  @ApiParam({ name: 'appId', description: 'Application ID' })
  @ApiResponse({ status: 200, type: AppRuntimeResponseDto })
  async updateReplicas(
    @Param('appId') appId: string,
    @Body() dto: UpdateReplicasDto,
  ): Promise<AppRuntimeResponseDto> {
    return this.appManagementService.updateReplicas(appId, dto);
  }

  @Get('autoscaling')
  @ApiOperation({
    summary: 'Replica autoscaling: the range and whether it runs',
    description:
      '`rangeFrom: manifest` means min and max come from flui.yaml `deploy.scaling`. `running` says whether the cluster runs the autoscaler now (null: it could not be asked).',
  })
  @ApiParam({ name: 'appId', description: 'Application ID' })
  @ApiResponse({ status: 200, type: AppAutoscalingDto })
  async getAutoscaling(
    @Param('appId') appId: string,
  ): Promise<AppAutoscalingDto> {
    return this.autoscaling.get(appId);
  }

  @Put('autoscaling')
  @AppAction(IAM_PERMISSION.SCALE_EXECUTE)
  @ApiOperation({
    summary: 'Let the replica count follow the load, between min and max',
    description:
      'Stores the range and CPU target and brings the cluster to it at once: the autoscaler is created, updated, or removed when `enabled` is false. Replicas that find no room wait for a node, which is what makes the scaling group buy one. Refused (409) for min, max or enabled on an app deployed from flui.yaml — change `deploy.scaling` there; 400 for an app that keeps data on each replica.',
  })
  @ApiParam({ name: 'appId', description: 'Application ID' })
  @ApiResponse({ status: 200, type: AppAutoscalingDto })
  async setAutoscaling(
    @Param('appId') appId: string,
    @Body() dto: UpdateAutoscalingDto,
  ): Promise<AppAutoscalingDto> {
    return this.autoscaling.set(appId, dto);
  }

  @Post('restart')
  @AppAction(IAM_PERMISSION.SCALE_EXECUTE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rolling restart',
    description:
      'Triggers a zero-downtime rolling restart by patching the restartedAt annotation on the pod template. ' +
      'Kubernetes replaces pods one by one respecting the configured RollingUpdate strategy.',
  })
  @ApiParam({ name: 'appId', description: 'Application ID' })
  @ApiResponse({ status: 200, type: AppRuntimeResponseDto })
  async restartDeployment(
    @Param('appId') appId: string,
  ): Promise<AppRuntimeResponseDto> {
    return this.appManagementService.restartDeployment(appId);
  }
}
