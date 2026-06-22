import { Controller, Get, Post, NotFoundException } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { ControlClusterService } from './control-cluster.service';
import { ClusterResponseDto } from '../clusters/dto/cluster-response.dto';
import { ClusterMapperService } from '../clusters/services/cluster-mapper.service';
import { ObservabilityEndpointsDto } from '../../grafana/dto/grafana-datasource.dto';
import { GrafanaDatasourceService } from '../../grafana/services/grafana-datasource.service';
import { GrafanaConfigService } from '../../grafana/services/grafana-config.service';
import { RequireSection } from '../../iam/decorators/require-section.decorator';

/**
 * Controller for managing control cluster operations
 * Provides endpoints to retrieve control cluster info and observability endpoints
 */
@ApiTags('Control Cluster')
@ApiBearerAuth()
@Controller('control-cluster')
@RequireSection('infrastructure')
export class ControlClusterController {
  constructor(
    private readonly controlClusterService: ControlClusterService,
    private readonly clusterMapperService: ClusterMapperService,
    private readonly grafanaDatasourceService: GrafanaDatasourceService,
    private readonly grafanaConfigService: GrafanaConfigService,
  ) {}

  /**
   * Get control cluster information
   * Returns the current control cluster details including status and configuration
   */
  @Get()
  @ApiOperation({
    summary: 'Get control cluster info',
    description:
      'Returns the control cluster details including endpoints, status, and configuration. ' +
      'This endpoint is used to check if an control cluster exists and retrieve its information.',
  })
  @ApiResponse({
    status: 200,
    description: 'Control cluster found',
    type: ClusterResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'No control cluster exists',
  })
  async getControlCluster(): Promise<ClusterResponseDto> {
    const cluster = await this.controlClusterService.getControlCluster();

    if (!cluster) {
      throw new NotFoundException(
        'No control cluster exists. Create one first using POST /api/v1/control-cluster',
      );
    }

    return this.clusterMapperService.mapToDto(cluster);
  }

  /**
   * Get observability service endpoints
   * Returns URLs for Prometheus, Loki, Grafana, and other services
   */
  @Get('endpoints')
  @ApiOperation({
    summary: 'Get observability service endpoints',
    description:
      'Returns the URLs for all observability services (Prometheus, Loki, Grafana, PostgreSQL, Redis). ' +
      'These endpoints are used by workload clusters to send metrics and logs to the control cluster.',
  })
  @ApiResponse({
    status: 200,
    description: 'Observability endpoints retrieved successfully',
    type: ObservabilityEndpointsDto,
  })
  @ApiResponse({
    status: 404,
    description: 'No control cluster exists or endpoints not available',
  })
  async getEndpoints(): Promise<ObservabilityEndpointsDto> {
    const cluster = await this.controlClusterService.getControlCluster();

    if (!cluster) {
      throw new NotFoundException(
        'No control cluster exists. Create one first using POST /api/v1/control-cluster',
      );
    }

    // Try to get endpoints from cluster metadata first (faster)
    if (cluster.metadata?.observabilityStack?.endpoints) {
      const endpoints = cluster.metadata.observabilityStack.endpoints;
      return {
        prometheus: endpoints.prometheus,
        loki: endpoints.loki,
        grafana: endpoints.grafana,
        postgres: endpoints.postgres,
        redis: endpoints.redis,
        fluiApi: endpoints.fluiApi,
      };
    }

    // If not in metadata, query Kubernetes (slower but more accurate)
    try {
      const endpoints =
        await this.controlClusterService.getObservabilityEndpoints(cluster.id);
      return {
        prometheus: endpoints.prometheus,
        loki: endpoints.loki,
        grafana: endpoints.grafana,
        postgres: endpoints.postgres,
        redis: endpoints.redis,
        fluiApi: endpoints.fluiApi,
      };
    } catch {
      throw new NotFoundException(
        `Control cluster exists but endpoints are not available. ` +
          `Cluster may not be ready yet. Current status: ${cluster.status}`,
      );
    }
  }

  /**
   * Test Grafana connection and configuration
   * Useful for verifying environment variables and connectivity without creating a cluster
   */
  @Get('test-grafana')
  @ApiOperation({
    summary: 'Test Grafana connection',
    description:
      'Tests the Grafana connection using current configuration (environment variables or cluster metadata). ' +
      'Useful for verifying GRAFANA_URL, GRAFANA_ADMIN_USERNAME, and GRAFANA_ADMIN_PASSWORD are correctly set. ' +
      'Does not create or modify any resources.',
  })
  @ApiResponse({
    status: 200,
    description: 'Grafana connection test result',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        url: { type: 'string' },
        username: { type: 'string' },
        message: { type: 'string' },
        configSource: {
          type: 'string',
          enum: ['cluster-metadata', 'environment-variables', 'fallback'],
        },
        error: { type: 'string' },
        details: { type: 'string' },
      },
    },
  })
  async testGrafanaConnection(): Promise<any> {
    try {
      // Get credentials to determine config source
      const credentials =
        await this.grafanaConfigService.getGrafanaCredentials();

      // Determine configuration source
      const cluster = await this.grafanaConfigService.getControlCluster();
      let configSource = 'fallback';

      if (
        cluster?.metadata?.observabilityStack?.endpoints?.grafana &&
        cluster?.metadata?.observabilityStack?.passwords?.grafana
      ) {
        configSource = 'cluster-metadata';
      } else if (
        process.env.GRAFANA_URL ||
        process.env.GRAFANA_ADMIN_PASSWORD
      ) {
        configSource = 'environment-variables';
      }

      // Test connection
      const isConnected =
        await this.grafanaDatasourceService.testGrafanaConnection();

      if (isConnected) {
        return {
          success: true,
          url: credentials.url,
          username: credentials.username,
          message: 'Grafana connection successful',
          configSource,
        };
      } else {
        return {
          success: false,
          url: credentials.url,
          username: credentials.username,
          error: 'Connection failed',
          details:
            'Connected to Grafana but received unexpected response. Check Grafana logs.',
          configSource,
        };
      }
    } catch (error) {
      // Return detailed error information
      return {
        success: false,
        error: error.message,
        details:
          'Failed to connect to Grafana. Possible causes: ' +
          '1) GRAFANA_ADMIN_PASSWORD not set, ' +
          '2) GRAFANA_URL incorrect, ' +
          '3) Grafana not accessible, ' +
          '4) Invalid credentials, ' +
          '5) No control cluster found',
        configSource: null,
      };
    }
  }

  /**
   * Create or update centralized Loki datasource in Grafana
   * Manually trigger datasource creation if it wasn't created during control cluster deployment
   */
  @Post('grafana-datasources/loki')
  @ApiOperation({
    summary: 'Create centralized Loki datasource',
    description:
      'Creates or updates the centralized Loki datasource in Grafana. ' +
      'This datasource is shared across all workload clusters and filters logs using labels (cluster_name, service, etc.). ' +
      'This endpoint is idempotent - if the datasource already exists, it will be updated. ' +
      'Useful for:\n' +
      '- Re-creating datasource if initial creation failed\n' +
      '- Updating datasource configuration (e.g., after LOKI_ENDPOINT change)\n' +
      '- Manual datasource management and debugging',
  })
  @ApiResponse({
    status: 201,
    description: 'Loki datasource created or updated successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        datasource: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              example: 'Centralized Loki - All Clusters',
            },
            uid: { type: 'string', example: 'centralized-loki' },
            type: { type: 'string', example: 'loki' },
            url: {
              type: 'string',
              example: 'http://observability-master-ip:30100',
            },
            isDefault: { type: 'boolean', example: true },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - LOKI_ENDPOINT not configured',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        error: { type: 'string' },
        details: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Control cluster not found or Grafana not accessible',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        error: { type: 'string' },
        details: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 500,
    description: 'Internal server error - Failed to create datasource',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        error: { type: 'string' },
        details: { type: 'string' },
      },
    },
  })
  async createLokiDatasource(): Promise<any> {
    try {
      // Verify control cluster exists
      const cluster = await this.controlClusterService.getControlCluster();

      if (!cluster) {
        throw new NotFoundException(
          'No control cluster exists. Create one first using POST /api/v1/control-cluster',
        );
      }

      // Create or update the centralized Loki datasource
      await this.grafanaDatasourceService.createCentralizedLokiDatasource();

      // Get LOKI_ENDPOINT from environment to return in response
      const lokiEndpoint = process.env.LOKI_ENDPOINT;

      return {
        success: true,
        message:
          'Centralized Loki datasource created or updated successfully. ' +
          'Use this datasource in Grafana with label filters: {cluster_name="...", service="...", etc.}',
        datasource: {
          name: 'Centralized Loki - All Clusters',
          uid: 'centralized-loki',
          type: 'loki',
          url: lokiEndpoint,
          isDefault: true,
        },
      };
    } catch (error) {
      // Handle specific error cases
      if (error instanceof NotFoundException) {
        throw error;
      }

      // Check for LOKI_ENDPOINT not configured
      if (error.message?.includes('LOKI_ENDPOINT not configured')) {
        return {
          success: false,
          error: 'LOKI_ENDPOINT not configured',
          details:
            'LOKI_ENDPOINT environment variable is not set. ' +
            'This should point to the Loki service on the control cluster (e.g., http://observability-master-ip:30100). ' +
            'Check your .env file and ensure LOKI_ENDPOINT is configured.',
        };
      }

      // Check for Grafana connection issues
      if (
        error.message?.includes('No control cluster found') ||
        error.message?.includes('Grafana endpoint or password')
      ) {
        throw new NotFoundException(
          'Control cluster exists but Grafana configuration is incomplete. ' +
            'Ensure observability stack has been deployed successfully with Grafana endpoints and credentials.',
        );
      }

      // Generic error
      return {
        success: false,
        error: error.message || 'Failed to create Loki datasource',
        details:
          'An unexpected error occurred while creating the Loki datasource. ' +
          'Check that:\n' +
          '1. Control cluster is READY\n' +
          '2. Grafana is accessible\n' +
          '3. LOKI_ENDPOINT is configured correctly\n' +
          '4. Grafana credentials are valid\n\n' +
          'For more details, check the API logs.',
      };
    }
  }
}
