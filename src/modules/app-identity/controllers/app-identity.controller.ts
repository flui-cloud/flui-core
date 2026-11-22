import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { AppIdentityService } from '../services/app-identity.service';
import {
  AppIdentityLinkDto,
  ConnectAppIdentityDto,
  IdentityInstallDto,
  IdentityUserDto,
  InviteIdentityUserDto,
} from '../dto/app-identity.dto';
import { AppIdentityLinkEntity } from '../entities/app-identity-link.entity';

const userOf = (req: Request) => req.user as AuthenticatedUser;

function toLink(link: AppIdentityLinkEntity): AppIdentityLinkDto {
  return {
    applicationId: link.applicationId,
    identityInstallId: link.identityInstallId,
    issuer: link.issuer,
    clientId: link.clientId,
    redirectUris: link.redirectUris,
    envNames: link.envNames,
  };
}

@ApiTags('Identity')
@ApiBearerAuth()
@Controller()
export class AppIdentityController {
  constructor(private readonly identity: AppIdentityService) {}

  @Get('identity/installs')
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary:
      'The identity installs you can read, to sign your apps’ users in with',
  })
  @ApiResponse({ status: 200, type: [IdentityInstallDto] })
  installs(@Req() req: Request): Promise<IdentityInstallDto[]> {
    return this.identity.installs(userOf(req));
  }

  @Get('identity/installs/:installId/users')
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({ summary: 'List the people of an identity install' })
  @ApiResponse({ status: 200, type: [IdentityUserDto] })
  users(
    @Param('installId', ParseUUIDPipe) installId: string,
    @Req() req: Request,
  ): Promise<IdentityUserDto[]> {
    return this.identity.users(userOf(req), installId);
  }

  @Post('identity/installs/:installId/users')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @ApiOperation({
    summary: 'Invite a person to an identity install',
    description:
      'The identity server mails the invitation through the email sender it is configured with.',
  })
  @ApiResponse({
    status: 201,
    schema: { properties: { id: { type: 'string' } } },
  })
  invite(
    @Param('installId', ParseUUIDPipe) installId: string,
    @Body() dto: InviteIdentityUserDto,
    @Req() req: Request,
  ): Promise<{ id: string }> {
    return this.identity.invite(userOf(req), installId, dto);
  }

  @Post('identity/installs/:installId/export')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @ApiOperation({
    summary: 'Export the users of an identity install',
    description:
      'In the identity server’s own import format, password hashes and one-time-password secrets included, so the users can be rebuilt on another install. Passkeys are not exported. Keep the file as you would the install itself.',
  })
  @ApiResponse({ status: 201, schema: { type: 'object' } })
  exportUsers(
    @Param('installId', ParseUUIDPipe) installId: string,
    @Req() req: Request,
  ): Promise<unknown> {
    return this.identity.exportUsers(userOf(req), installId);
  }

  @Post('identity/installs/:installId/users/:userId/block')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Stop a person from signing in to the apps of an identity install',
  })
  async block(
    @Param('installId', ParseUUIDPipe) installId: string,
    @Param('userId') userId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.identity.setBlocked(userOf(req), installId, userId, true);
  }

  @Post('identity/installs/:installId/users/:userId/unblock')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Let a blocked person sign in again' })
  async unblock(
    @Param('installId', ParseUUIDPipe) installId: string,
    @Param('userId') userId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.identity.setBlocked(userOf(req), installId, userId, false);
  }

  @Get('applications/:id/identity')
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary:
      'Which identity install an application signs its users in with, if any',
  })
  @ApiResponse({ status: 200, type: AppIdentityLinkDto })
  async link(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<AppIdentityLinkDto | null> {
    const link = await this.identity.linkOf(userOf(req), id);
    return link ? toLink(link) : null;
  }

  @Put('applications/:id/identity')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @ApiOperation({
    summary: 'Sign an application’s users in with an identity install',
    description:
      'Makes a client for the application on the identity install and hands the application only the issuer, client id and client secret, then redeploys it.',
  })
  @ApiResponse({ status: 200, type: AppIdentityLinkDto })
  async connect(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConnectAppIdentityDto,
    @Req() req: Request,
  ): Promise<AppIdentityLinkDto> {
    return toLink(await this.identity.connect(userOf(req), id, dto));
  }

  @Delete('applications/:id/identity')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Stop signing an application’s users in with its identity install',
  })
  async disconnect(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.identity.disconnect(userOf(req), id);
  }
}
