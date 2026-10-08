import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ProjectEntity } from './entities/project.entity';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import {
  ownerUnknown,
  projectNamespace,
} from '../applications/utils/k8s-namespace.util';
import { ownerUserIdFor } from '../applications/utils/application-owner.util';
import { ProjectSpacesService } from './project-spaces.service';

export const PROJECT_MOVE_REFUSED_CODE = 'PROJECT_MOVE_REFUSED';
export const PROJECT_NOT_EMPTY_CODE = 'PROJECT_NOT_EMPTY';
export const PROJECT_SPACE_NOT_REMOVED_CODE = 'PROJECT_SPACE_NOT_REMOVED';

export interface ProjectPlacement {
  project: ProjectEntity;
  namespace: string;
}

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(ProjectEntity)
    private readonly projects: Repository<ProjectEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly apps: Repository<ApplicationEntity>,
    private readonly spaces: ProjectSpacesService,
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

  /**
   * A project is the namespace its applications run in, so one that still
   * holds applications cannot go: they would be left running in a namespace
   * nothing describes. Its spaces go with it, and until they have the name
   * stays taken: a new project with the same name would otherwise inherit
   * whatever was left in them.
   */
  async remove(id: string): Promise<void> {
    const project = await this.get(id);
    const held = await this.apps.count({
      where: { projectId: project.id, deletedAt: IsNull() },
    });
    if (held > 0) {
      throw new ConflictException({
        code: PROJECT_NOT_EMPTY_CODE,
        message: `Project ${project.slug} still holds ${held} application(s). Delete them first.`,
      });
    }
    const { failed } = await this.spaces.removeAll(project);
    if (failed.length > 0) {
      throw new ServiceUnavailableException({
        code: PROJECT_SPACE_NOT_REMOVED_CODE,
        message: `Project ${project.slug} was not deleted: its space could not be removed from ${failed
          .map((f) => f.cluster)
          .join(', ')}. Try again once the cluster answers.`,
      });
    }
    await this.projects.delete(project.id);
  }

  /**
   * A demo area: a project nobody owns yet, built ahead with its namespace so
   * that handing it to a guest is a single update. Named so a list of
   * projects never says whose it will be.
   */
  async createArea(): Promise<ProjectEntity> {
    return this.projects.save(
      this.projects.create({
        name: 'Demo area',
        slug: await this.uniqueSlug(`area-${randomUUID().split('-')[0]}`),
        description: null,
        color: null,
        ownerUserId: null,
      }),
    );
  }

  /** Deletes a person's personal project once it holds nothing. */
  async removePersonal(userId: string): Promise<void> {
    const project = await this.projects.findOne({
      where: { ownerUserId: userId },
    });
    if (!project) return;
    const held = await this.apps.count({
      where: { projectId: project.id, deletedAt: IsNull() },
    });
    if (held > 0) return;
    const { failed } = await this.spaces.removeAll(project);
    if (failed.length === 0) await this.projects.delete(project.id);
  }

  /**
   * Where an application lands: the project asked for, or the creator's
   * personal one. The namespace follows from the project and nothing else.
   */
  async placementFor(input: {
    projectId?: string | null;
    userId?: string | null;
  }): Promise<ProjectPlacement> {
    const project = input.projectId
      ? await this.get(input.projectId)
      : await this.defaultFor(input.userId);
    return { project, namespace: projectNamespace(project.slug) };
  }

  /**
   * A person lands in their personal project. A service credential
   * (`cli-bootstrap`, `cli-service-account`) is a declared name with no `users`
   * row, so it cannot own one: it gets a project of its own, named after it.
   */
  private async defaultFor(
    principalId: string | null | undefined,
  ): Promise<ProjectEntity> {
    if (!principalId) throw ownerUnknown();
    if (ownerUserIdFor(principalId)) return this.personalFor(principalId);
    return this.serviceProjectFor(principalId);
  }

  private async serviceProjectFor(name: string): Promise<ProjectEntity> {
    const slug = `service-${this.slugify(name)}`;
    const existing = await this.projects.findOne({ where: { slug } });
    if (existing) return existing;
    try {
      return await this.projects.save(
        this.projects.create({
          name,
          slug,
          description: 'Applications created by this service credential.',
          color: null,
          ownerUserId: null,
        }),
      );
    } catch (error) {
      const raced = await this.projects.findOne({ where: { slug } });
      if (raced) return raced;
      throw error;
    }
  }

  /**
   * The person's own project, made the first time it is needed. Named and
   * slugged without the person's email: the project list is readable by every
   * signed-in user, and a demo instance has strangers among them.
   */
  async personalFor(userId: string | null | undefined): Promise<ProjectEntity> {
    if (!userId) throw ownerUnknown();
    const existing = await this.projects.findOne({
      where: { ownerUserId: userId },
    });
    if (existing) return existing;

    try {
      return await this.projects.save(
        this.projects.create({
          name: 'Personal',
          slug: await this.uniqueSlug(`personal-${userId.slice(0, 8)}`),
          description: null,
          color: null,
          ownerUserId: userId,
        }),
      );
    } catch (error) {
      // Two first deploys of the same person at once: the unique index lets
      // one through, the other reads what it made.
      const raced = await this.projects.findOne({
        where: { ownerUserId: userId },
      });
      if (raced) return raced;
      throw error;
    }
  }

  /**
   * Moving an application to another project moves it to another namespace,
   * which means moving its volumes: a migration, not an assignment. Refused
   * until that migration exists.
   */
  async assignApp(projectId: string, appId: string): Promise<void> {
    const project = await this.get(projectId);
    const app = await this.apps.findOne({
      where: { id: appId },
      select: { id: true, projectId: true },
    });
    if (!app) throw new NotFoundException(`Application ${appId} not found`);
    if (app.projectId === project.id) return;
    throw this.moveRefused();
  }

  async unassignApp(appId: string): Promise<void> {
    const app = await this.apps.findOne({
      where: { id: appId },
      select: { id: true },
    });
    if (!app) throw new NotFoundException(`Application ${appId} not found`);
    throw this.moveRefused();
  }

  private moveRefused(): ConflictException {
    return new ConflictException({
      code: PROJECT_MOVE_REFUSED_CODE,
      message:
        'An application stays in the project it was created in: its project is its namespace, and moving it means moving its data.',
    });
  }

  private slugify(name: string): string {
    return (
      name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50)
        .replace(/-$/, '') || 'project'
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
