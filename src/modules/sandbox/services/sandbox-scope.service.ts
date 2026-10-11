import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, IsNull, Raw, Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import {
  SandboxTenantEntity,
  SandboxTenantState,
} from '../entities/sandbox-tenant.entity';
import {
  SandboxScope,
  SandboxScopeField,
} from '../constants/sandbox-projection';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';
import { SHOWCASE_TAG } from '../../iam/constants/iam-showcase';

/**
 * Where a projection's idea of "yours" comes from.
 *
 * Both answers are derived from the guest's own rows — the tenancy for the
 * cluster, the guest's applications for the projects — never from
 * `SANDBOX_CLUSTER_ID`. A tenancy claimed before the setting changed would
 * otherwise be shown a cluster it is not on.
 */
@Injectable()
export class SandboxScopeService {
  constructor(
    @InjectRepository(SandboxTenantEntity)
    private readonly tenants: Repository<SandboxTenantEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
  ) {}

  async resolve(
    userId: string,
    needs: readonly SandboxScopeField[],
  ): Promise<SandboxScope> {
    const [clusterId, projectIds, applicationIds, showcaseApplicationIds] =
      await Promise.all([
        needs.includes('clusterId') ? this.clusterIdFor(userId) : null,
        needs.includes('projectIds')
          ? this.projectIdsFor(userId)
          : new Set<string>(),
        needs.includes('applicationIds')
          ? this.applicationIdsFor(userId)
          : new Set<string>(),
        needs.includes('showcaseApplicationIds')
          ? this.showcaseApplicationIds()
          : new Set<string>(),
      ]);
    return {
      userId,
      clusterId,
      projectIds,
      applicationIds,
      showcaseApplicationIds,
    };
  }

  private async clusterIdFor(userId: string): Promise<string | null> {
    const tenant = await this.tenants.findOne({
      where: { userId, state: SandboxTenantState.CLAIMED },
      select: { id: true, clusterId: true },
    });
    // A guest who has not deployed yet holds no area, and still needs to see
    // the one cluster their first deploy is allowed on.
    return tenant?.clusterId ?? this.config.clusterId ?? null;
  }

  private async applicationIdsFor(userId: string): Promise<Set<string>> {
    const rows = await this.applications.find({
      where: { userId },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  private async showcaseApplicationIds(): Promise<Set<string>> {
    const rows = await this.applications.find({
      where: {
        deletedAt: IsNull(),
        tags: Raw((tags) => `${tags} @> :showcase::jsonb`, {
          showcase: JSON.stringify([SHOWCASE_TAG]),
        }),
      },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  /**
   * The guest's own projects and the ones the showcase lives in: the guest
   * already sees those applications, and a list that hides where they are
   * reads as "no projects" next to them.
   */
  private async projectIdsFor(userId: string): Promise<Set<string>> {
    const rows = await this.applications.find({
      where: [
        { userId, projectId: Not(IsNull()), deletedAt: IsNull() },
        {
          projectId: Not(IsNull()),
          deletedAt: IsNull(),
          tags: Raw((tags) => `${tags} @> :showcase::jsonb`, {
            showcase: JSON.stringify([SHOWCASE_TAG]),
          }),
        },
      ],
      select: { id: true, projectId: true },
    });
    return new Set(
      rows
        .map((row) => row.projectId)
        .filter((id): id is string => typeof id === 'string'),
    );
  }
}
