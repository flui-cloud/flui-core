import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { ClusterReferences } from './cluster-references';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves a cluster reference against the cluster registry.
 *
 * By id first and by name second, because an id is what the answer has to be:
 * a name is what a person types and the thing they can change tomorrow. Two
 * queries rather than one `OR`, so a cluster whose *name* happens to be another
 * cluster's id cannot make the second one's notes disappear.
 *
 * The id query is skipped for anything that is not shaped like one. `id` is a
 * `uuid` column, and handing it `control-cluster` makes Postgres refuse the
 * value — which the malformed-identifier filter then turns into "one of the
 * values in this request is not a valid identifier", a true sentence that
 * answers the wrong question. A name is not a malformed id; it is a name.
 *
 * Only the id column is selected. This class exists to answer one question and
 * has no business loading a row that holds an encrypted kubeconfig.
 */
@Injectable()
export class RegistryClusterReferences implements ClusterReferences {
  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
  ) {}

  async canonicalIdOf(reference: string): Promise<string | null> {
    const trimmed = reference.trim();
    if (!trimmed) return null;

    if (UUID.test(trimmed)) {
      const byId = await this.clusters.findOne({
        where: { id: trimmed },
        select: { id: true },
      });
      if (byId) return byId.id;
    }

    const byName = await this.clusters.findOne({
      where: { name: trimmed },
      select: { id: true },
    });
    return byName?.id ?? null;
  }
}
