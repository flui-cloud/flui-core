import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Whether this installation publishes its sandbox tenancies under a subdomain
 * of its own, which label that is, and on which cluster.
 *
 * Read here rather than from `SANDBOX_CONFIG` so the DNS module does not have
 * to depend on the sandbox module to answer a question about hostnames. The
 * cluster id is the same `SANDBOX_CLUSTER_ID` the sandbox itself reads: one
 * value, two readers, and no third place for an operator to keep in step.
 *
 * Off unless `FLUI_SANDBOX_SUBDOMAIN` is `true`. An installation that says
 * nothing keeps naming every application `<slug>.<cluster>.<zone>`, which is
 * what it does today.
 */
@Injectable()
export class SandboxSubdomainConfigService {
  private static readonly ENABLED_KEY = 'FLUI_SANDBOX_SUBDOMAIN';
  private static readonly LABEL_KEY = 'FLUI_SANDBOX_SUBDOMAIN_LABEL';
  private static readonly CLUSTER_KEY = 'SANDBOX_CLUSTER_ID';
  private static readonly DEFAULT_LABEL = 'demo';

  constructor(private readonly configService: ConfigService) {}

  isEnabled(): boolean {
    const raw = this.configService.get<string | boolean | undefined>(
      SandboxSubdomainConfigService.ENABLED_KEY,
    );
    if (raw === undefined || raw === null) return false;
    if (typeof raw === 'boolean') return raw;
    return String(raw).trim().toLowerCase() === 'true';
  }

  /** The label, `demo` unless the installation names another one. */
  label(): string {
    const raw = this.configService.get<string | undefined>(
      SandboxSubdomainConfigService.LABEL_KEY,
    );
    const trimmed = String(raw ?? '').trim();
    return trimmed || SandboxSubdomainConfigService.DEFAULT_LABEL;
  }

  /**
   * The cluster whose address `*.<label>` points at. Null means the record is
   * published for nobody: the label describes one cluster's applications, and
   * pointing it at whichever cluster reconciles last would send a guest's
   * visitors to a machine that never heard of them.
   */
  sandboxClusterId(): string | null {
    const raw = this.configService.get<string | undefined>(
      SandboxSubdomainConfigService.CLUSTER_KEY,
    );
    const trimmed = String(raw ?? '').trim();
    return trimmed || null;
  }

  /** True when `clusterId` is the one the shared subdomain belongs to. */
  ownsCluster(clusterId: string): boolean {
    if (!this.isEnabled()) return false;
    const sandboxClusterId = this.sandboxClusterId();
    return !!sandboxClusterId && sandboxClusterId === clusterId;
  }
}
