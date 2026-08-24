import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AuthzInstallService } from '../services/authz-install.service';
import { InstallAuthzDto } from '../dto/install-authz.dto';
import { AuthzInstallResponseDto } from '../dto/authz-install-response.dto';
import { ClusterAuthzInstallEntity } from '../entities/cluster-authz-install.entity';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

@ApiTags('authz')
@Controller('authz/install')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AuthzInstallController {
  constructor(private readonly service: AuthzInstallService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Install flui-authz on a workload cluster (OIDC only)',
  })
  @ApiResponse({ status: 202, type: AuthzInstallResponseDto })
  async install(
    @Body() dto: InstallAuthzDto,
    @Req() req: { user?: AuthenticatedUser },
  ): Promise<AuthzInstallResponseDto> {
    const { install } = await this.service.install(dto, req.user?.userId);
    return this.toResponse(install);
  }

  @Get()
  @ApiOperation({ summary: 'List flui-authz installations' })
  @ApiResponse({ status: 200, type: [AuthzInstallResponseDto] })
  async findAll(): Promise<AuthzInstallResponseDto[]> {
    const installs = await this.service.findAll();
    return installs.map((i) => this.toResponse(i));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get flui-authz install status' })
  @ApiResponse({ status: 200, type: AuthzInstallResponseDto })
  async findOne(@Param('id') id: string): Promise<AuthzInstallResponseDto> {
    return this.toResponse(await this.service.findOne(id));
  }

  // Nothing asked anything here: any logged-in account could tear the auth proxy
  // off any cluster. The screen that offers it is already administrator-only, so
  // naming the permission the rest of that plane uses takes nothing from anybody.
  @Delete(':id')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Uninstall flui-authz from cluster' })
  @ApiResponse({ status: 202, type: AuthzInstallResponseDto })
  async uninstall(
    @Param('id') id: string,
    @Req() req: { user?: AuthenticatedUser },
  ): Promise<AuthzInstallResponseDto> {
    const { install } = await this.service.uninstall(id, req.user?.userId);
    return this.toResponse(install);
  }

  private toResponse(
    install: ClusterAuthzInstallEntity,
  ): AuthzInstallResponseDto {
    return {
      id: install.id,
      clusterId: install.clusterId,
      clusterName: install.clusterName,
      status: install.status,
      operationId: install.operationId,
      errorMessage: install.errorMessage,
      installedAt: install.installedAt,
      createdAt: install.createdAt,
      updatedAt: install.updatedAt,
    };
  }
}
