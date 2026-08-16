import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../auth/decorators/public.decorator';
import { CapabilitiesProviderFactory } from '../core/factories/capabilities-provider.factory';
import { CloudProvider } from '../enums/cloud-provider.enum';
import { ProviderSchemaDto } from '../dto/provider-schema.dto';

/**
 * Public, unauthenticated description of what each provider needs before it can
 * be used: which credential fields to ask for, whether they come as one token
 * or a pair, and where the user finds them.
 *
 * It has to be public because every consumer runs *before* an authenticated
 * Flui exists — the CLI during environment bootstrap, and the managed funnel,
 * which is talking to a cluster that has not been created yet. Both currently
 * carry their own copy of this table; this endpoint is what lets them stop.
 *
 * Nothing here is sensitive: it is the shape of a credential, never a value.
 */
@ApiTags('providers')
@Controller('providers')
export class ProviderSchemasController {
  constructor(private readonly capabilities: CapabilitiesProviderFactory) {}

  @Get('schemas')
  @Public()
  @ApiOperation({
    summary: 'Credential schemas for every supported provider',
    description:
      'What to ask the user for, per provider. Public because it is needed before a Flui installation exists.',
  })
  @ApiResponse({ status: 200, type: [ProviderSchemaDto] })
  async all(): Promise<ProviderSchemaDto[]> {
    const providers = this.capabilities.getSupportedProviders();
    const schemas = await Promise.all(providers.map((p) => this.describe(p)));
    return schemas.filter(
      (schema): schema is ProviderSchemaDto => schema !== null,
    );
  }

  @Get('schemas/:provider')
  @Public()
  @ApiOperation({ summary: 'Credential schema for one provider' })
  @ApiParam({ name: 'provider', enum: CloudProvider })
  @ApiResponse({ status: 200, type: ProviderSchemaDto })
  async one(
    @Param('provider') provider: CloudProvider,
  ): Promise<ProviderSchemaDto> {
    const schema = await this.describe(provider);
    if (!schema) throw new NotFoundException(`Unknown provider "${provider}".`);
    return schema;
  }

  private async describe(
    provider: CloudProvider,
  ): Promise<ProviderSchemaDto | null> {
    if (!this.capabilities.isProviderSupported(provider)) return null;
    const info = await this.capabilities
      .getCapabilitiesService(provider)
      .getProviderInfo();
    return {
      provider: info.name,
      displayName: info.displayName,
      credentialType: info.credentialFields.type,
      fields: info.credentialFields.fields.map((field) => ({
        key: field.key,
        label: field.label,
        hint: field.hint ?? '',
        secret: field.secret,
        required: field.required,
      })),
      documentationUrl:
        info.accessKeyDocumentationUrl ?? info.documentationUrl ?? '',
      consoleUrl: info.websiteUrl ?? '',
    };
  }
}
