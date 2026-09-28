import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApplicationAccessService } from '../../applications/services/application-access.service';
import {
  AppCoverageService,
  FleetCoverage,
} from '../../backups/services/app-coverage.service';
import { CredentialsStatusService } from '../../credentials/services/credentials-status.service';
import {
  NeedsYou,
  NeedsYouItem,
  assembleNeedsYou,
  backupItem,
  clusterItems,
  credentialItems,
} from '../utils/needs-you.rules';

/**
 * What the home asks of the person in front of it, in one read: broken
 * clusters, clusters being worked on, credentials that are not valid, and
 * applications holding data that no recent backup protects.
 */
@Injectable()
export class FleetAttentionService {
  private readonly logger = new Logger(FleetAttentionService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly access: ApplicationAccessService,
    private readonly coverage: AppCoverageService,
    private readonly credentials: CredentialsStatusService,
  ) {}

  /** Backup coverage of the applications this caller may read. */
  async coverageFor(
    user: AuthenticatedUser,
    clusterId?: string,
  ): Promise<FleetCoverage> {
    const candidates = await this.coverage.candidates(clusterId);
    const readable = await this.access.filterReadable(user, candidates);
    return this.coverage.forApplications(readable);
  }

  async needsYou(user: AuthenticatedUser, now = new Date()): Promise<NeedsYou> {
    const [clusters, credentials, coverage] = await Promise.all([
      this.clusters.find({
        where: { status: Not(ClusterStatus.DELETED) },
        order: { createdAt: 'DESC' },
      }),
      this.credentials.getStatus(user.userId).catch((err: Error) => {
        this.logger.warn(`Credential status unavailable: ${err.message}`);
        return null;
      }),
      this.coverageFor(user),
    ]);

    const items: NeedsYouItem[] = [
      ...clusterItems(clusters),
      ...credentialItems(credentials?.items ?? []),
    ];
    const backups = backupItem(coverage.applications);
    if (backups) items.push(backups);
    return assembleNeedsYou(items, now);
  }
}
