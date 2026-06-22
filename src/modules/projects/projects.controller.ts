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
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../auth/guards/admin.guard';
import { Admin } from '../auth/decorators/admin.decorator';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

/**
 * Reads are auth-only (projects are low-sensitivity reference data, like
 * clusters); mutations are admin-only for now. A `project:manage` permission can
 * replace @Admin once the IAM catalog is extended.
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
  @UseGuards(AdminGuard)
  @Admin()
  create(@Body() dto: CreateProjectDto) {
    return this.projects.create(dto);
  }

  @Patch(':id')
  @UseGuards(AdminGuard)
  @Admin()
  update(@Param('id') id: string, @Body() dto: UpdateProjectDto) {
    return this.projects.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(AdminGuard)
  @Admin()
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.projects.remove(id);
  }

  @Post(':id/apps/:appId')
  @UseGuards(AdminGuard)
  @Admin()
  @HttpCode(HttpStatus.NO_CONTENT)
  assign(@Param('id') id: string, @Param('appId') appId: string) {
    return this.projects.assignApp(id, appId);
  }

  @Delete(':id/apps/:appId')
  @UseGuards(AdminGuard)
  @Admin()
  @HttpCode(HttpStatus.NO_CONTENT)
  unassign(@Param('appId') appId: string) {
    return this.projects.unassignApp(appId);
  }
}
