import {
  Controller,
  Get,
  Put,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { AppConfigService } from '../services/app-config.service';
import {
  UpsertVariablesDto,
  UpsertClusterVariablesDto,
  AppVariablesResponseDto,
  AppVariablesCombinedResponseDto,
  VariableSetSummaryDto,
  VariableType,
} from '../dto/app-config.dto';

@ApiTags('Variables')
@ApiBearerAuth()
@Controller('variables')
export class VariablesController {
  constructor(private readonly appConfigService: AppConfigService) {}

  // ── App-scoped ─────────────────────────────────────────────────────────
  //
  //  GET  /variables/applications/:appId?type=all|plain|sensitive
  //  PUT  /variables/applications/:appId?type=plain|sensitive

  @Get('applications/:appId')
  @ApiOperation({
    summary: 'Read application variables',
    description:
      'Returns the variables for an application discovered from the K8s Deployment spec. ' +
      'type=all (default): plain values + sensitive keys masked as "****". ' +
      'type=plain: only ConfigMap values. ' +
      'type=sensitive: only Secret keys masked as "****".',
  })
  @ApiParam({ name: 'appId', description: 'Application ID' })
  @ApiQuery({
    name: 'type',
    enum: VariableType,
    required: false,
    description: 'Variable type (default: all)',
  })
  @ApiResponse({ status: 200, type: AppVariablesCombinedResponseDto })
  async getAppVariables(
    @Param('appId') appId: string,
    @Query('type') type: VariableType = VariableType.ALL,
  ): Promise<AppVariablesCombinedResponseDto> {
    return this.appConfigService.getAppVariablesCombined(appId, type);
  }

  @Put('applications/:appId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Upsert application variables',
    description:
      'Replaces variables for an application directly on K8s (full replace — keys not in the payload are removed). ' +
      'type=plain → ConfigMap (<slug>-config); type=sensitive → Secret (<slug>-secrets, values base64-encoded). ' +
      'Returns the combined view after the upsert.',
  })
  @ApiParam({ name: 'appId', description: 'Application ID' })
  @ApiQuery({
    name: 'type',
    enum: [VariableType.PLAIN, VariableType.SENSITIVE],
    required: false,
    description: 'Variable type (default: plain)',
  })
  @ApiResponse({ status: 200, type: AppVariablesCombinedResponseDto })
  async upsertAppVariables(
    @Param('appId') appId: string,
    @Body() dto: UpsertVariablesDto,
    @Query('type') type: VariableType = VariableType.PLAIN,
  ): Promise<AppVariablesCombinedResponseDto> {
    if (type === VariableType.SENSITIVE) {
      await this.appConfigService.upsertAppSecret(
        appId,
        dto.data,
        dto.deleteKeys,
      );
    } else {
      await this.appConfigService.upsertAppConfig(
        appId,
        dto.data,
        dto.deleteKeys,
      );
    }
    return this.appConfigService.getAppVariablesCombined(
      appId,
      VariableType.ALL,
    );
  }

  // ── Cluster-scoped listing ─────────────────────────────────────────────
  //
  //  GET  /variables/clusters/:clusterId/namespaces/:namespace

  @Get('clusters/:clusterId/namespaces/:namespace')
  @ApiOperation({
    summary: 'List variable sets in a cluster namespace',
    description:
      'Returns all Flui-managed variable sets in the given namespace of a cluster. ' +
      'Filter by type (plain | sensitive | all) and scope (app | system | all). ' +
      'type=plain includes key-value data; type=sensitive returns only key names (values never exposed).',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiParam({
    name: 'namespace',
    description: 'Kubernetes namespace (e.g. "default")',
  })
  @ApiQuery({
    name: 'type',
    enum: ['plain', 'sensitive', 'all'],
    required: false,
    description: 'Variable type filter (default: all)',
  })
  @ApiQuery({
    name: 'scope',
    enum: ['app', 'system', 'all'],
    required: false,
    description: 'Scope filter (default: all)',
  })
  @ApiResponse({ status: 200, type: [VariableSetSummaryDto] })
  async listClusterVariables(
    @Param('clusterId') clusterId: string,
    @Param('namespace') namespace: string,
    @Query('type') type: 'plain' | 'sensitive' | 'all' = 'all',
    @Query('scope') scope: 'app' | 'system' | 'all' = 'all',
  ): Promise<VariableSetSummaryDto[]> {
    const results: VariableSetSummaryDto[] = [];

    if (type === 'plain' || type === 'all') {
      const configs = await this.appConfigService.listClusterConfigs(
        clusterId,
        scope,
        namespace,
      );
      results.push(
        ...configs.map((c) => ({
          name: c.name,
          type: VariableType.PLAIN,
          scope: c.scope,
          resourceVersion: c.resourceVersion,
          keys: c.keys,
          data: c.data,
        })),
      );
    }

    if (type === 'sensitive' || type === 'all') {
      const secrets = await this.appConfigService.listClusterSecrets(
        clusterId,
        scope,
        namespace,
      );
      results.push(
        ...secrets.map((s) => ({
          name: s.name,
          type: VariableType.SENSITIVE,
          scope: s.scope,
          resourceVersion: s.resourceVersion,
          keys: s.keys,
        })),
      );
    }

    return results;
  }

  // ── Cluster-scoped read/write by name ──────────────────────────────────
  //
  //  GET  /variables/clusters/:clusterId/namespaces/:namespace/:name
  //  PUT  /variables/clusters/:clusterId/namespaces/:namespace/:name

  @Get('clusters/:clusterId/namespaces/:namespace/:name')
  @ApiOperation({
    summary: 'Read a variable set by name from a cluster namespace',
    description:
      'Returns variables for the named set in the given namespace. ' +
      'type=plain returns key-value data; type=sensitive returns only key names.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiParam({
    name: 'namespace',
    description: 'Kubernetes namespace (e.g. "default")',
  })
  @ApiParam({
    name: 'name',
    description: 'Variable set name (e.g. flui-api-config, flui-secrets)',
  })
  @ApiQuery({
    name: 'type',
    enum: VariableType,
    required: false,
    description: 'Variable type (default: plain)',
  })
  @ApiResponse({ status: 200, type: AppVariablesResponseDto })
  @ApiResponse({ status: 404, description: 'Variable set not found' })
  async getClusterVariables(
    @Param('clusterId') clusterId: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Query('type') type: VariableType = VariableType.PLAIN,
  ): Promise<AppVariablesResponseDto> {
    if (type === VariableType.SENSITIVE) {
      const result = await this.appConfigService.getClusterSecret(
        clusterId,
        name,
        namespace,
      );
      return {
        name: result.name,
        type: VariableType.SENSITIVE,
        scope: result.scope,
        keys: result.keys,
        resourceVersion: result.resourceVersion,
      };
    }
    const result = await this.appConfigService.getClusterConfig(
      clusterId,
      name,
      namespace,
    );
    return {
      name: result.name,
      type: VariableType.PLAIN,
      scope: result.scope,
      data: result.data,
      resourceVersion: result.resourceVersion,
    };
  }

  @Put('clusters/:clusterId/namespaces/:namespace/:name')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Upsert a variable set by name in a cluster namespace',
    description:
      'Replaces a variable set in the given namespace (full replace — keys not in the payload are removed). Existing scope labels are preserved. ' +
      'type=plain → ConfigMap; type=sensitive → Secret (values base64-encoded). ' +
      'The "flui-secrets" set is protected and returns 403.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiParam({
    name: 'namespace',
    description: 'Kubernetes namespace (e.g. "default")',
  })
  @ApiParam({ name: 'name', description: 'Variable set name' })
  @ApiQuery({
    name: 'type',
    enum: VariableType,
    required: false,
    description: 'Variable type (default: plain)',
  })
  @ApiResponse({ status: 200, type: AppVariablesResponseDto })
  @ApiResponse({ status: 403, description: 'Variable set is protected' })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async upsertClusterVariables(
    @Param('clusterId') clusterId: string,
    @Param('namespace') namespace: string,
    @Param('name') name: string,
    @Body() dto: UpsertClusterVariablesDto,
    @Query('type') type: VariableType = VariableType.PLAIN,
  ): Promise<AppVariablesResponseDto> {
    if (type === VariableType.SENSITIVE) {
      const result = await this.appConfigService.upsertClusterSecret(
        clusterId,
        name,
        dto.data,
        namespace,
      );
      return {
        name: result.name,
        type: VariableType.SENSITIVE,
        scope: result.scope,
        keys: result.keys,
        resourceVersion: result.resourceVersion,
      };
    }
    const result = await this.appConfigService.upsertClusterConfig(
      clusterId,
      name,
      dto.data,
      namespace,
    );
    return {
      name: result.name,
      type: VariableType.PLAIN,
      scope: result.scope,
      data: result.data,
      resourceVersion: result.resourceVersion,
    };
  }
}
