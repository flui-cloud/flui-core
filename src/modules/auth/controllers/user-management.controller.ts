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
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { Admin } from '../decorators/admin.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import {
  CreateIdentityUserDto,
  CreatedIdentityUserDto,
} from '../dto/create-identity-user.dto';
import { UpdateIdentityRoleDto } from '../dto/update-identity-role.dto';
import { ListIdentityUsersQueryDto } from '../dto/list-identity-users.query';
import {
  ResetPasswordDto,
  ResetPasswordResultDto,
} from '../dto/reset-password.dto';
import {
  InviteLinkRequestDto,
  InviteLinkResultDto,
} from '../dto/invite-link.dto';
import { UserManagementService } from '../services/user-management.service';
import { IdentityUser } from '../interfaces/identity-directory.interface';
import { RequireSection } from '../../iam/decorators/require-section.decorator';

@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth/users')
@UseGuards(JwtAuthGuard)
@RequireSection('access')
export class UserManagementController {
  constructor(private readonly users: UserManagementService) {}

  @Post()
  @UseGuards(AdminGuard)
  @Admin()
  @ApiOperation({ summary: 'Create a new identity user (admin)' })
  @ApiCreatedResponse({ type: CreatedIdentityUserDto })
  create(@Body() dto: CreateIdentityUserDto): Promise<CreatedIdentityUserDto> {
    return this.users.createUser(dto);
  }

  @Get()
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  @ApiOperation({ summary: 'List identity users (requires iam:assign-role)' })
  list(@Query() query: ListIdentityUsersQueryDto): Promise<IdentityUser[]> {
    return this.users.listUsers(query);
  }

  @Get(':id')
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  @ApiOperation({
    summary: 'Get identity user details (requires iam:assign-role)',
  })
  async get(@Param('id') id: string): Promise<IdentityUser> {
    const user = await this.users.getUser(id);
    if (!user) {
      // 404 thrown via service in delete/setRole; replicate here for direct GET
      throw new (await import('@nestjs/common')).NotFoundException(
        `User ${id} not found`,
      );
    }
    return user;
  }

  @Delete(':id')
  @UseGuards(AdminGuard)
  @Admin()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an identity user (admin)' })
  async delete(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<void> {
    await this.users.deleteUser(id, req.user.userId);
  }

  @Patch(':id/role')
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Change role for an identity user (requires iam:assign-role)',
  })
  async setRole(
    @Param('id') id: string,
    @Body() dto: UpdateIdentityRoleDto,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<void> {
    await this.users.setRole(id, dto.role, req.user.userId);
  }

  @Post(':id/reset-password')
  @UseGuards(AdminGuard)
  @Admin()
  @ApiOperation({
    summary: 'Reset password / resend invite for an identity user (admin)',
  })
  @ApiOkResponse({ type: ResetPasswordResultDto })
  reset(
    @Param('id') id: string,
    @Body() dto: ResetPasswordDto,
  ): Promise<ResetPasswordResultDto> {
    return this.users.resetPassword(id, dto.sendInvite);
  }

  @Post(':id/invite-link')
  @UseGuards(AdminGuard)
  @Admin()
  @ApiOperation({
    summary: 'Generate a copyable invite link for a user (admin)',
    description:
      'The link needs no email. Pass `send: true` to have Flui email it as well — the link is ' +
      'still returned, and `delivery` reports what became of the message. Generating a link ' +
      'ROTATES the code, so do not regenerate between handing one out and the user opening it.',
  })
  @ApiOkResponse({ type: InviteLinkResultDto })
  inviteLink(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
    @Body() dto?: InviteLinkRequestDto,
  ): Promise<InviteLinkResultDto> {
    return this.users.createInviteLink(id, {
      ...(dto?.send ? { send: true } : {}),
      invitedBy: req.user.displayName || req.user.email,
    });
  }
}
