import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import {
  CONSOLE_TARGET_ABSENT,
  foundationReachOf,
} from '../constants/platform-foundations';
import { DbConnectionInfo } from '../interfaces/db-connection';
import { SystemDbAuditService } from './system-db-audit.service';

/**
 * Turns a foundation key into the coordinates a native client needs, and does
 * nothing else.
 *
 * Deliberately nothing else: it opens no connection, asks
 * {@link KubePortForwardService} for no tunnel — which would be refused at the
 * transport, and rightly — reads no Secret and returns no password. Everything
 * it hands back is already true of any cluster the caller can SSH into; what it
 * saves her is guessing which pod, which database and which role, which is
 * exactly the part that is written down in the bootstrap and nowhere she can
 * read it.
 *
 * A key that names no declared reach answers {@link CONSOLE_TARGET_ABSENT},
 * the same absence a console gives, so the pair of foundations cannot be
 * enumerated by anyone who got this far and does not already know them.
 */
@Injectable()
export class SystemDbAccessService {
  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly audit: SystemDbAuditService,
  ) {}

  async connectionInfo(
    key: string,
    userId: string | undefined,
  ): Promise<DbConnectionInfo> {
    const reach = foundationReachOf(key);
    if (!reach) {
      this.audit.emit({
        foundationKey: key,
        userId,
        result: 'deny',
        reason: 'unknown_foundation',
      });
      throw new NotFoundException(CONSOLE_TARGET_ABSENT);
    }

    // The foundations only ever run on the control cluster, and legacy rows
    // still say `observability` for it — the same pair every other lookup of
    // "which cluster is the control cluster" reads.
    const control = await this.clusterRepository.findOne({
      where: {
        clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
      },
    });
    if (!control) {
      this.audit.emit({
        foundationKey: reach.key,
        userId,
        result: 'deny',
        reason: 'control_cluster_absent',
      });
      throw new NotFoundException(CONSOLE_TARGET_ABSENT);
    }

    this.audit.emit({
      foundationKey: reach.key,
      userId,
      clusterId: control.id,
      result: 'allow',
      reason: null,
    });

    return {
      engine: reach.engine,
      database: reach.database,
      user: reach.user,
      namespace: reach.namespace,
      podLabelSelector: reach.podLabelSelector,
      clusterId: control.id,
      remotePort: reach.remotePort,
    };
  }
}
