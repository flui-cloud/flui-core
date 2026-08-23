import {
  Controller,
  Get,
  Patch,
  Post,
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
import { AppAccessGuard } from '../guards/app-access.guard';
import {
  UpdateResourcesDto,
  UpdateReplicasDto,
  AppRuntimeResponseDto,
} from '../dto/app-management.dto';

@ApiTags('Application Management')
@ApiBearerAuth()
@Controller('applications/:appId')
// Every route here names one application and three of the four change it. The
// guard reads `:appId` as well as `:id`, so mounting it on the class is the
// whole gate: GET asks app:read, the writes ask app:write.
@UseGuards(AppAccessGuard)
export class AppManagementController {
  constructor(private readonly appManagementService: AppManagementService) {}

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

  @Patch('replicas')
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

  @Post('restart')
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
