import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Post,
  Request,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { ValidationResultDto } from '../../management/dto/validation-result.dto';
import { InferenceProviderService } from '../services/inference-provider.service';
import { InferenceConnectionService } from '../services/inference-connection.service';
import { CreateInferenceConnectionDto } from '../dto/create-inference-connection.dto';
import { InferenceProviderInfoDto } from '../dto/inference-provider-info.dto';
import { InferenceConnectionDto } from '../dto/inference-connection.dto';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';

@ApiTags('Inference')
@Controller('inference')
@ApiBearerAuth()
export class InferenceController {
  constructor(
    private readonly providers: InferenceProviderService,
    private readonly connections: InferenceConnectionService,
  ) {}

  @Get('providers')
  @ApiOperation({
    summary: 'List inference-capable providers and their models',
  })
  @ApiResponse({ status: 200, type: [InferenceProviderInfoDto] })
  async listProviders(): Promise<InferenceProviderInfoDto[]> {
    return this.providers.listProviders();
  }

  @Post('providers/:provider/validate')
  @ApiOperation({
    summary: 'Test the provider credential against its inference endpoint',
  })
  @ApiParam({ name: 'provider', enum: CloudProvider })
  @ApiResponse({ status: 200, type: ValidationResultDto })
  @HttpCode(HttpStatus.OK)
  async validateProvider(
    @Param('provider', new ParseEnumPipe(CloudProvider))
    provider: CloudProvider,
  ): Promise<ValidationResultDto> {
    return this.providers.validate(provider);
  }

  // The installation's connections plus the caller's own. A colleague's
  // personal row is not in this answer, and decision 104 is explicit that
  // hiding it from the list is not the guard — the guard is where the id is
  // spent, because that path never reads this list.
  @Get('connections')
  @ApiOperation({
    summary: "List the installation's BYO inference connections plus your own",
  })
  @ApiResponse({ status: 200, type: [InferenceConnectionDto] })
  async listConnections(
    @Request() req: { user: AuthenticatedUser },
  ): Promise<InferenceConnectionDto[]> {
    return this.connections.list(req.user);
  }

  // The installation's level. The row it writes has no owner, which is what
  // every assistant on the installation borrows and what the key it carries is
  // charged for — so it keeps the permission the delete below asks for, and the
  // pair stays symmetric: whichever answer the product gives, "anyone may plug
  // one in and only a maintainer may unplug it" is not one of them.
  //
  // Decision 104 splits the person's level onto its own route rather than
  // loosening this one: the giro N answer was right for the row it was written
  // about, and stays.
  @Post('connections')
  @RequirePermission(IAM_PERMISSION.INTEGRATION_MANAGE)
  @ApiOperation({
    summary:
      'Connect any OpenAI-compatible LLM for the whole installation (BYO-key)',
  })
  @ApiResponse({ status: 201, type: InferenceConnectionDto })
  async createConnection(
    @Body() dto: CreateInferenceConnectionDto,
  ): Promise<InferenceConnectionDto> {
    return this.connections.create(dto, null);
  }

  // The person's level, and it asks for no permission on purpose: decision 104
  // says anybody may bring her own model and take it away again, and the whole
  // point of bringing one is that it is hers — visible to nobody else, spendable
  // by nobody else. The owner comes from the credential, never from the body.
  @Post('connections/mine')
  @ApiOperation({
    summary: 'Connect an OpenAI-compatible LLM of your own (BYO-key, private)',
  })
  @ApiResponse({ status: 201, type: InferenceConnectionDto })
  async createOwnConnection(
    @Request() req: { user: AuthenticatedUser },
    @Body() dto: CreateInferenceConnectionDto,
  ): Promise<InferenceConnectionDto> {
    return this.connections.create(dto, req.user.userId);
  }

  // Validation calls the provider with the key, so it spends it. That makes it
  // the same question as a chat turn and not the same question as the list.
  @Post('connections/:id/validate')
  @ApiOperation({ summary: 'Validate a BYO inference connection' })
  @ApiResponse({ status: 200, type: ValidationResultDto })
  @HttpCode(HttpStatus.OK)
  async validateConnection(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<ValidationResultDto> {
    return this.connections.validate(id, req.user);
  }

  // A connection is the *instance's* credential to a model provider: one row,
  // borrowed by every assistant on the installation, listed with no owner. Until
  // now any authenticated account could remove it for everybody, and the settings
  // screen that offers it is shown to all of them. `integration:manage` rather
  // than `cluster:manage` because it touches no cluster and because no agent
  // scope carries it — an agent must not be able to unplug the model it speaks
  // through. This narrows `viewer` and `operator`, deliberately.
  @Delete('connections/:id')
  @RequirePermission(IAM_PERMISSION.INTEGRATION_MANAGE)
  @ApiOperation({
    summary: "Delete the installation's BYO inference connection",
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteConnection(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<void> {
    await this.connections.remove(id, req.user);
  }

  // Switching off a credential you brought yourself must never need a
  // permission — the same decision already written on `DELETE /auth/api-keys/:id`
  // and named in the sentinel: a principal who may hold a credential and may not
  // revoke it is the worst state a credential model can be in. It is a separate
  // route rather than a branch inside the one above precisely so the
  // installation's row keeps its gate, and no agent scope reaches it.
  @Delete('connections/mine/:id')
  @ApiOperation({ summary: 'Disconnect a model you connected yourself' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteOwnConnection(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<void> {
    await this.connections.removeOwn(id, req.user);
  }
}
