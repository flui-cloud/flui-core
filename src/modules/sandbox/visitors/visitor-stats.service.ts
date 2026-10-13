import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { USER_KIND, UserEntity } from '../../auth/entities/user.entity';
import { SandboxVisitorEntity } from '../entities/sandbox-visitor.entity';
import { SandboxVisitorStatsDto } from '../dto/sandbox-visitor-stats.dto';
import { VisitorPoolService } from './visitor-pool.service';
import { VisitorRefusalsService } from './visitor-refusals.service';
import { VISITOR_CONFIG, VisitorConfig } from './visitor.config';

const DAY_MS = 24 * 3_600_000;

interface VisitorCounts {
  created: string;
  upgraded: string;
  merged: string;
}

/** What the visitors' entrance has been doing, for whoever runs the demo. */
@Injectable()
export class VisitorStatsService {
  constructor(
    @Inject(VISITOR_CONFIG) private readonly config: VisitorConfig,
    @InjectRepository(SandboxVisitorEntity)
    private readonly visitors: Repository<SandboxVisitorEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly pool: VisitorPoolService,
    private readonly refusals: VisitorRefusalsService,
  ) {}

  async stats(now = new Date()): Promise<SandboxVisitorStatsDto> {
    const since = new Date(now.getTime() - DAY_MS);
    const [visitorsNow, poolReady, counts, refusedByReason] = await Promise.all(
      [
        this.users.count({ where: { kind: USER_KIND.VISITOR } }),
        this.pool.ready(now),
        this.counts(since),
        this.refusals.since(since),
      ],
    );
    return {
      entranceOpen: this.config.enabled,
      visitorsNow,
      poolReady,
      poolMin: this.config.poolMin,
      upgraded: Number(counts?.upgraded ?? 0),
      merged: Number(counts?.merged ?? 0),
      last24h: {
        created: Number(counts?.created ?? 0),
        refused: refusedByReason.reduce((n, r) => n + r.count, 0),
        refusedByReason,
      },
    };
  }

  /** A merged visitor's person row is gone; one that became an account keeps it. */
  private counts(since: Date): Promise<VisitorCounts | undefined> {
    return this.visitors
      .createQueryBuilder('v')
      .leftJoin(UserEntity, 'u', 'u."id" = v."userId"')
      .select('COUNT(*) FILTER (WHERE v."createdAt" >= :since)', 'created')
      .addSelect(
        'COUNT(*) FILTER (WHERE v."upgradedAt" IS NOT NULL AND u."id" IS NOT NULL)',
        'upgraded',
      )
      .addSelect(
        'COUNT(*) FILTER (WHERE v."upgradedAt" IS NOT NULL AND u."id" IS NULL)',
        'merged',
      )
      .setParameter('since', since)
      .getRawOne<VisitorCounts>();
  }
}
