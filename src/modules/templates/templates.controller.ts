import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { TemplatesService } from './templates.service';
import {
  TemplateResponseDto,
  UseTemplateDto,
  UseTemplateResponseDto,
} from './dto/template.dto';
import { TemplateConfig } from './config/template-registry';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Public } from '../auth/decorators/public.decorator';

/** A listed template; the source repository is present only for authenticated callers. */
type TemplateListItem = Omit<TemplateConfig, 'repo' | 'repoUrl'> &
  Partial<Pick<TemplateConfig, 'repo' | 'repoUrl'>>;

@ApiTags('Templates')
@ApiBearerAuth()
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  /**
   * Open on purpose: "what can I deploy here?" is the first question a new user —
   * or an agent sizing Flui up — asks, and it comes before any account exists.
   * The answer is static product metadata with no tenancy and no user data, the
   * same class of information as the public catalog.
   *
   * The source repository is NOT part of that answer. It is only needed once a
   * template is actually used, which is authenticated either way, so anonymous
   * callers get the catalogue without it — no reason to publish the org's repo
   * names, least of all the ones that are still private.
   */
  @Public()
  @Get()
  @ApiOperation({
    summary: 'List all templates',
    description:
      'List all available framework templates with metadata. Callable without a token; ' +
      '`repo` and `repoUrl` are included only for authenticated callers.',
  })
  @ApiResponse({
    status: 200,
    description: 'Templates listed',
    type: [TemplateResponseDto],
  })
  listTemplates(@Req() req: Request): TemplateListItem[] {
    const templates = this.templatesService.listTemplates();
    if (req.user) return templates;
    return templates.map(({ repo: _repo, repoUrl: _repoUrl, ...rest }) => rest);
  }

  @Get(':framework')
  @ApiOperation({
    summary: 'Get template details',
    description:
      'Get details for a specific framework template. When `version` is omitted, returns the `isDefault` entry.',
  })
  @ApiQuery({
    name: 'version',
    required: false,
    description: 'Pin a specific major version, e.g. `16` for Next.js',
  })
  @ApiResponse({
    status: 200,
    description: 'Template found',
    type: TemplateResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Template not found' })
  getTemplate(
    @Param('framework') framework: string,
    @Query('version') version?: string,
  ): TemplateConfig {
    return this.templatesService.getTemplate(framework, version);
  }

  @Post(':framework/use')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Generate a new repository from a template',
    description:
      "Creates a new repository in the user's GitHub account starting from the selected Flui template. " +
      'Requires the user to have connected GitHub via OAuth with the "repo" scope. ' +
      'The returned repository can then be linked to a Flui application via POST /repositories.',
  })
  @ApiResponse({
    status: 201,
    description: 'Repository created from template',
    type: UseTemplateResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid request, missing scopes, or GitHub error',
  })
  @ApiResponse({
    status: 404,
    description: 'Template not found or template repo not accessible',
  })
  @ApiResponse({
    status: 409,
    description: 'A repository with this name already exists',
  })
  useTemplate(
    @Req() req: Request,
    @Param('framework') framework: string,
    @Body() dto: UseTemplateDto,
  ): Promise<UseTemplateResponseDto> {
    const { userId } = req.user as AuthenticatedUser;
    return this.templatesService.useTemplate(userId, framework, dto);
  }
}
