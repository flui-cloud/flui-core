import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationAccessService } from '../../applications/services/application-access.service';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import { InfrastructureOperationEntity } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { AppBuildEntity } from '../entities/app-build.entity';
import {
  BuildOwnershipLookups,
  mayActOnBuild,
} from '../helpers/build-ownership.helper';

/**
 * The build routes' authorization, in one place instead of three.
 *
 * `AppBuildsController` carries `AppAccessGuard` and the three
 * `applications/builds/:buildId` routes ask this same question in their
 * handlers, because the guard passes anything without an application in the
 * path. The other two controllers asked nothing at all: a sandbox guest was
 * refused at the fence, and everybody else — an `operator` scoped to their own
 * applications included — could read, start and delete builds that were not
 * theirs.
 */
@Injectable()
export class BuildAccessService {
  constructor(
    @InjectRepository(AppBuildEntity)
    private readonly builds: Repository<AppBuildEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operations: Repository<InfrastructureOperationEntity>,
    private readonly access: ApplicationAccessService,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  /**
   * The build, once the caller is allowed to act on it.
   *
   * `NotFoundException` for a build that does not exist and a refusal for one
   * that belongs to somebody else: telling those two apart is the point, since
   * a 404 for both would let a caller enumerate build ids.
   */
  async buildForCaller(
    buildId: string,
    user: AuthenticatedUser | undefined,
    action: string,
  ): Promise<AppBuildEntity> {
    const build = await this.builds.findOne({ where: { id: buildId } });
    if (!build) {
      throw new NotFoundException(`Build ${buildId} not found`);
    }
    if (!(await mayActOnBuild(build, user, action, this.lookups()))) {
      throw new ForbiddenException(`Not allowed to ${action} on build`);
    }
    return build;
  }

  lookups(): BuildOwnershipLookups {
    return {
      application: (id) => this.applications.findOne({ where: { id } }),
      canOnApplication: (user, action, app) =>
        this.access.can(user, action, app),
      operation: (id) => this.operations.findOne({ where: { id } }),
      policy: this.policy,
    };
  }
}
