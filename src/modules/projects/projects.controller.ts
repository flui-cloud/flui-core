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
} from '@nestjs/common';
import { RequireSection } from '../iam/decorators/require-section.decorator';
import { SECTION } from '../iam/constants/iam-sections';
import { RequirePermission } from '../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../iam/constants/iam-permissions';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

/**
 * Reads are auth-only (projects are low-sensitivity reference data, like
 * clusters); the five writes ask for the `projects` section, which is
 * `iam:assign-role` at global scope — the same gate the sidebar entry uses.
 *
 * No `project:manage` of its own: a project is an org-and-RBAC grouping, not a
 * subject with a life of its own, and the section already names exactly the
 * population that decides who belongs where. The two reads stay open, as they
 * were: nobody counted their callers, and closing them here would have been a
 * change nobody asked for.
 */
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list() {
    return this.projects.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.projects.get(id);
  }

  @Post()
  @RequireSection(SECTION.PROJECTS)
  create(@Body() dto: CreateProjectDto) {
    return this.projects.create(dto);
  }

  @Patch(':id')
  @RequireSection(SECTION.PROJECTS)
  update(@Param('id') id: string, @Body() dto: UpdateProjectDto) {
    return this.projects.update(id, dto);
  }

  @Delete(':id')
  @RequireSection(SECTION.PROJECTS)
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.projects.remove(id);
  }

  @Post(':id/apps/:appId')
  @RequireSection(SECTION.PROJECTS)
  @HttpCode(HttpStatus.NO_CONTENT)
  assign(@Param('id') id: string, @Param('appId') appId: string) {
    return this.projects.assignApp(id, appId);
  }

  @Delete(':id/apps/:appId')
  @RequireSection(SECTION.PROJECTS)
  @RequirePermission(IAM_PERMISSION.IAM_ASSIGN_ROLE)
  @HttpCode(HttpStatus.NO_CONTENT)
  unassign(@Param('appId') appId: string) {
    return this.projects.unassignApp(appId);
  }
}
