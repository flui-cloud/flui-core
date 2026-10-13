import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Put,
  Request,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import {
  DemoSignInService,
  SIGN_IN_PROVIDER_KINDS,
  SignInProviderKind,
} from '../services/demo-sign-in.service';
import {
  ConnectSignInProviderDto,
  SignInProviderStatusDto,
  SignInProvidersDto,
} from '../dto/sandbox-sign-in.dto';

function providerOf(raw: string): SignInProviderKind {
  const kind = SIGN_IN_PROVIDER_KINDS.find((k) => k === raw);
  if (!kind) {
    throw new NotFoundException(
      `No sign-in provider "${raw}": one of ${SIGN_IN_PROVIDER_KINDS.join(', ')}`,
    );
  }
  return kind;
}

function actorOf(user: AuthenticatedUser | undefined): string {
  return user?.email || user?.userId || 'unknown';
}

/**
 * GitHub and Google sign-in for the demo's guests.
 *
 * The client secret crosses this API once, on its way to the identity provider,
 * which keeps it encrypted. It is not written to the configuration, the
 * database, a log or a response; what Flui keeps is the client ID, the
 * identity provider's id for it, and who connected it when.
 *
 * Writing is `sandbox:operate`, the demo's own permission, and no agent scope
 * carries it. Reading is `cluster:read`: nothing on it is secret, and it is
 * what `sign_in_provider_request` reads to tell an agent whether to ask a
 * person. A guest reaches neither, because the sandbox fence does not open
 * this path.
 */
@ApiTags('Sandbox')
@ApiBearerAuth()
@Controller('sandbox/sign-in/providers')
export class SandboxSignInController {
  constructor(private readonly signIn: DemoSignInService) {}

  @Get()
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'GitHub and Google sign-in on the demo, without their secrets',
    description:
      'Which providers guests can sign in with, where each came from, and the callback URL to register at GitHub or Google. A provider still configured through the deprecated SANDBOX_*_CLIENT_* variables reports `source: environment`; one they created before being removed reports `source: identity-provider`.',
  })
  @ApiResponse({ status: 200, type: SignInProvidersDto })
  list(): Promise<SignInProvidersDto> {
    return this.signIn.list();
  }

  @Put(':provider')
  @RequirePermission(IAM_PERMISSION.SANDBOX_OPERATE)
  @ApiOperation({
    summary: 'Connect GitHub or Google sign-in, or give it new credentials',
    description:
      'Creates the provider on the identity provider, or updates the one already there, and shows it on the sign-in page. The client secret is handed to the identity provider and kept nowhere else. Only on a demo installation.',
  })
  @ApiParam({ name: 'provider', enum: ['github', 'google'] })
  @ApiResponse({ status: 200, type: SignInProviderStatusDto })
  @ApiResponse({ status: 409, description: 'Not a demo installation' })
  @ApiResponse({
    status: 502,
    description: 'The identity provider refused or did not answer',
  })
  connect(
    @Param('provider') provider: string,
    @Body() dto: ConnectSignInProviderDto,
    @Request() req: { user?: AuthenticatedUser },
  ): Promise<SignInProviderStatusDto> {
    return this.signIn.connect(
      providerOf(provider),
      { clientId: dto.clientId, clientSecret: dto.clientSecret },
      actorOf(req.user),
    );
  }

  @Delete(':provider')
  @RequirePermission(IAM_PERMISSION.SANDBOX_OPERATE)
  @ActionCycle({
    action: 'DELETE /sandbox/sign-in/providers/:provider',
    bind: ['provider'],
    sentence: 'take {provider} sign-in off the demo',
    consequence:
      'Guests can no longer sign in with that provider, including the ones who already did; its credentials are deleted from the identity provider.',
  })
  @ApiOperation({
    summary: 'Disconnect GitHub or Google sign-in',
    description:
      'Takes the provider off the sign-in page and deletes it, credentials included, from the identity provider. Remembered as disconnected, so the deprecated variables do not bring it back.',
  })
  @ApiParam({ name: 'provider', enum: ['github', 'google'] })
  @ApiResponse({ status: 200, type: SignInProviderStatusDto })
  disconnect(
    @Param('provider') provider: string,
    @Request() req: { user?: AuthenticatedUser },
  ): Promise<SignInProviderStatusDto> {
    return this.signIn.disconnect(providerOf(provider), actorOf(req.user));
  }
}
