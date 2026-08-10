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

@ApiTags('Templates')
@ApiBearerAuth()
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  // The registry is static product metadata — the same class of information as
  // the public catalog, with no tenancy and no user data. Gating it behind a
  // token means "what can I deploy?" cannot be answered before signing up, by a
  // person or by an agent evaluating Flui.
  @Public()
  @Get()
  @ApiOperation({
    summary: 'List all templates',
    description: 'List all available framework templates with metadata',
  })
  @ApiResponse({
    status: 200,
    description: 'Templates listed',
    type: [TemplateResponseDto],
  })
  listTemplates(): TemplateConfig[] {
    return this.templatesService.listTemplates();
  }

  @Public()
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
