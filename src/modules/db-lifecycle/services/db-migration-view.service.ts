import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ClusterNodeEntity } from '../../infrastructure/clusters/entities/cluster-node.entity';
import { WireGuardLinkEntity } from '../../infrastructure/networking/entities/wireguard-link.entity';
import { DbMigrationEntity } from '../entities/db-migration.entity';
import { DbReplicationLinkEntity } from '../entities/db-replication-link.entity';
import { DbMigrationView, dbMigrationView } from '../utils/db-migration-view';
import { DbMigrationService } from './db-migration.service';

/** Database migrations as every surface reads them: the row plus its link, fence and copy. */
@Injectable()
export class DbMigrationViewService {
  constructor(
    private readonly migrations: DbMigrationService,
    @InjectRepository(DbReplicationLinkEntity)
    private readonly replRepo: Repository<DbReplicationLinkEntity>,
    @InjectRepository(WireGuardLinkEntity)
    private readonly wgRepo: Repository<WireGuardLinkEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodeRepo: Repository<ClusterNodeEntity>,
  ) {}

  async getView(id: string): Promise<DbMigrationView> {
    return (await this.views([await this.migrations.findById(id)]))[0];
  }

  async listViews(userId: string): Promise<DbMigrationView[]> {
    return this.views(await this.migrations.list(userId));
  }

  async views(migs: DbMigrationEntity[]): Promise<DbMigrationView[]> {
    const linkIds = ids(migs.map((m) => m.linkId));
    const repls = linkIds.length
      ? await this.replRepo.find({ where: { id: In(linkIds) } })
      : [];
    const wgIds = ids(repls.map((r) => r.wgLinkId));
    const wgs = wgIds.length
      ? await this.wgRepo.find({ where: { id: In(wgIds) } })
      : [];
    const nodeIds = ids(wgs.flatMap((w) => [w.listenerNodeId, w.dialerNodeId]));
    const nodes = nodeIds.length
      ? await this.nodeRepo.find({ where: { id: In(nodeIds) } })
      : [];
    const nodeNames = new Map(nodes.map((n) => [n.id, n.serverName]));

    return migs.map((mig) => {
      const repl = repls.find((r) => r.id === mig.linkId) ?? null;
      const wg = repl?.wgLinkId
        ? (wgs.find((w) => w.id === repl.wgLinkId) ?? null)
        : null;
      return dbMigrationView(mig, { repl, wg, nodeNames });
    });
  }
}

function ids(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}
