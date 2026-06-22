import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectEntity } from './entities/project.entity';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(ProjectEntity)
    private readonly projects: Repository<ProjectEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly apps: Repository<ApplicationEntity>,
  ) {}

  list(): Promise<ProjectEntity[]> {
    return this.projects.find({ order: { name: 'ASC' } });
  }

  async get(id: string): Promise<ProjectEntity> {
    const project = await this.projects.findOne({ where: { id } });
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    return project;
  }

  async create(dto: CreateProjectDto): Promise<ProjectEntity> {
    const entity = this.projects.create({
      name: dto.name,
      slug: await this.uniqueSlug(dto.name),
      description: dto.description ?? null,
      color: dto.color ?? null,
    });
    return this.projects.save(entity);
  }

  async update(id: string, dto: UpdateProjectDto): Promise<ProjectEntity> {
    const project = await this.get(id);
    if (dto.name !== undefined) project.name = dto.name;
    if (dto.description !== undefined)
      project.description = dto.description ?? null;
    if (dto.color !== undefined) project.color = dto.color ?? null;
    return this.projects.save(project);
  }

  async remove(id: string): Promise<void> {
    // Apps keep existing; their projectId is set NULL via the FK (onDelete).
    const res = await this.projects.delete(id);
    if (!res.affected) throw new NotFoundException(`Project ${id} not found`);
  }

  async assignApp(projectId: string, appId: string): Promise<void> {
    await this.get(projectId);
    const res = await this.apps.update(appId, { projectId });
    if (!res.affected)
      throw new NotFoundException(`Application ${appId} not found`);
  }

  async unassignApp(appId: string): Promise<void> {
    const res = await this.apps.update(appId, { projectId: null });
    if (!res.affected)
      throw new NotFoundException(`Application ${appId} not found`);
  }

  private slugify(name: string): string {
    return (
      name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'project'
    );
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base = this.slugify(name);
    let slug = base;
    let n = 2;
    while ((await this.projects.count({ where: { slug } })) > 0) {
      slug = `${base}-${n++}`;
    }
    return slug;
  }
}
