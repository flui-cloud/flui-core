import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  SandboxTenantEntity,
  SandboxTenantState,
} from '../entities/sandbox-tenant.entity';
import { DEFAULT_SANDBOX_QUOTA } from '../constants/sandbox-quota.manifest';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';
import {
  NodeStorageQuotaService,
  StorageQuotaReconciliation,
} from '../../infrastructure/clusters/services/node-storage-quota.service';
import { parseStorageQuantityToBytes } from '../../../common/utils/storage-quantity.util';

/**
 * States worth capping. A tenancy being built has no directories yet and an
 * expired one is the reaper's, so both would only add noise to a pass that
 * otherwise does nothing when there is nothing to do.
 */
const LIVE_STATES = [SandboxTenantState.READY, SandboxTenantState.CLAIMED];

/**
 * Making the guests' declared storage true.
 *
 * Their `ResourceQuota` already says `requests.storage: 12Gi`, and it always
 * has — but that ceiling counts only the sizes written on claims, and the
 * storage behind them enforces none of them: a claim of 1Mi accepts 50MiB.
 * This makes the number true, on the one disk where a guest's databases live.
 *
 * It runs on a clock rather than at claim time: a tenancy has no directories
 * until the guest deploys something, so there is nothing to tag when the area
 * is handed over.
 */
@Injectable()
export class SandboxStorageQuotaService {
  private readonly logger = new Logger(SandboxStorageQuotaService.name);

  constructor(
    @InjectRepository(SandboxTenantEntity)
    private readonly tenants: Repository<SandboxTenantEntity>,
    private readonly nodeQuotas: NodeStorageQuotaService,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
  ) {}

  /**
   * The bytes a tenancy may write, which is not the number on their quota.
   *
   * `requests.storage` is summed from the sizes declared on claims, so it
   * governs how many applications a guest may install, not how much data they
   * may keep: the catalogue declares 10Gi for a code editor that starts out
   * holding a few megabytes. Enforcing that figure on disk would size the node
   * for storage nobody uses.
   */
  private limitBytes(): number {
    return parseStorageQuantityToBytes(DEFAULT_SANDBOX_QUOTA.nodeLocalCeiling);
  }

  async apply(): Promise<StorageQuotaReconciliation | null> {
    const clusterId = this.config.clusterId;
    if (!clusterId) return null;

    const live = await this.tenants.find({
      where: { clusterId, state: In(LIVE_STATES) },
      select: { namespace: true },
    });
    if (live.length === 0) return null;

    const bytes = this.limitBytes();
    const result = await this.nodeQuotas.reconcile(
      clusterId,
      live.map((t) => ({ namespace: t.namespace, bytes })),
    );

    // Said once, at the level it belongs to: a demo cluster that has not been
    // rebuilt on a quota-capable filesystem is not broken, it simply cannot
    // keep this promise yet, and pretending otherwise in the log would hide
    // exactly the thing somebody needs to know before opening the doors.
    const without = result.nodes.filter((n) => !n.supported);
    if (without.length === result.nodes.length && without.length > 0) {
      this.logger.warn(
        `Guest storage ceilings are not being enforced: ${without[0].reason ?? 'no quota support'}`,
      );
    }

    return result;
  }
}
