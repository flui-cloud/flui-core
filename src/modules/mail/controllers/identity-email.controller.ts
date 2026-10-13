import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../auth/decorators/public.decorator';
import {
  IdentityEmailService,
  type IdentityEmailReceipt,
} from '../services/identity-email.service';
import { IDENTITY_SIGNATURE_HEADER } from '../utils/identity-email-signature.util';

/**
 * Where the identity provider hands over its sign-in mail. Public, because the
 * identity provider cannot sign in as a Flui user, and verified inside against
 * the signing key it issued. Its own controller so no guard on the mail
 * section is ever loosened to let it through.
 */
@ApiTags('Webhooks')
@Controller('identity')
export class IdentityEmailController {
  constructor(private readonly identityEmail: IdentityEmailService) {}

  @Post('email')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  receive(
    @Headers(IDENTITY_SIGNATURE_HEADER) signature: string | undefined,
    @Req() req: RawBodyRequest<Request>,
    @Body() body: unknown,
  ): Promise<IdentityEmailReceipt> {
    return this.identityEmail.receive(
      signature,
      req.rawBody ?? Buffer.alloc(0),
      body,
    );
  }
}
