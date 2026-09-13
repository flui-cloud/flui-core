import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { ClusterNodeEntity } from '../../infrastructure/clusters/entities/cluster-node.entity';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { ClusterBillingService } from '../../infrastructure/clusters/services/cluster-billing.service';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { StorageBackendProvider } from '../../storage/enums/storage-backend-provider.enum';

interface ProviderPricing {
  baseCentsPerMonth: number;
  includedGb: number;
  marginalCentsPerGb: number;
}

/**
 * Politica costi: o si recupera da fonte affidabile (provider API o user
 * override esplicito), o si ritorna `null`. NESSUN valore di default
 * inventato — il FE mostrerà "Costi non disponibili" quando non c'è dato.
 */

export type EstimateProfile = 'single' | 'mirrored';

const DISCLAIMER =
  'Costi stimati. Variano in base a utilizzo effettivo, sconti commerciali e modifiche di listino del provider.';

const NOT_AVAILABLE_REASON_NO_PRICING_API =
  'Pricing API not yet integrated for this provider — costs unavailable.';
const NOT_AVAILABLE_REASON_PROVIDER_NOT_HETZNER =
  'Cluster billing currently supported only for Hetzner. Other providers will be added.';
const NOT_AVAILABLE_REASON_DESTINATION_NO_COST =
  'No cost-per-GB set on this BackupDestination and no provider pricing API integrated. Set costPerGbMonthCents on the destination to enable estimates.';

export interface NodeCostBreakdown {
  nodeId: string;
  type: string;
  cents: number | null;
  unavailableReason?: string;
}

export interface ClusterCostEstimate {
  clusterMonthlyCents: number | null;
  unavailableReason?: string;
  nodeBreakdown: NodeCostBreakdown[];
  currency: 'EUR';
  disclaimer: string;
}

export interface DestinationCostBreakdown {
  provider: StorageBackendProvider | string;
  centsPerMonth: number | null;
  unavailableReason?: string;
}

export interface BackupEstimateResult {
  estimatedDataGb: number | null;
  estimatedDataReason?: string;
  estimatedDataSource?: 'last-backup' | 'pvc-requests';
  primary: DestinationCostBreakdown;
  replica?: DestinationCostBreakdown;
  totalCentsPerMonth: number | null; // null se almeno una componente non disponibile
  unavailableReason?: string;
  currency: 'EUR';
  disclaimer: string;
}

@Injectable()
export class BillingEstimatorService {
  private readonly logger = new Logger(BillingEstimatorService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodeRepo: Repository<ClusterNodeEntity>,
    private readonly encryption: EncryptionService,
    private readonly k8s: KubernetesService,
    private readonly clusterBilling: ClusterBillingService,
    private readonly destRepo: BackupDestinationRepository,
    private readonly artifactRepo: BackupArtifactRepository,
    private readonly config: ConfigService,
  ) {}

  private providerPricingFromEnv(
    provider: StorageBackendProvider,
  ): ProviderPricing | null {
    const prefixMap: Partial<Record<StorageBackendProvider, string>> = {
      [StorageBackendProvider.SCALEWAY_OBJECT_STORAGE]:
        'FLUI_BACKUP_PRICE_SCALEWAY_OS',
      [StorageBackendProvider.OVH_OBJECT_STORAGE]: 'FLUI_BACKUP_PRICE_OVH_OS',
    };
    const prefix = prefixMap[provider];
    if (!prefix) return null;
    const base = this.config.get<string>(`${prefix}_BASE_CENTS_PER_MONTH`);
    const included = this.config.get<string>(`${prefix}_INCLUDED_GB`);
    const marginal = this.config.get<string>(`${prefix}_MARGINAL_CENTS_PER_GB`);
    if (base == null || included == null || marginal == null) return null;
    const b = Number(base);
    const i = Number(included);
    const m = Number(marginal);
    if (!Number.isFinite(b) || !Number.isFinite(i) || !Number.isFinite(m)) {
      return null;
    }
    return {
      baseCentsPerMonth: b,
      includedGb: i,
      marginalCentsPerGb: m,
    };
  }

  async estimateClusterMonthlyCost(
    clusterId: string,
  ): Promise<ClusterCostEstimate> {
    const cluster = await this.clusterRepo.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      return {
        clusterMonthlyCents: null,
        unavailableReason: 'Cluster not found',
        nodeBreakdown: [],
        currency: 'EUR',
        disclaimer: DISCLAIMER,
      };
    }
    if (cluster.provider !== CloudProvider.HETZNER) {
      const nodes = await this.nodeRepo.find({ where: { clusterId } });
      return {
        clusterMonthlyCents: null,
        unavailableReason: NOT_AVAILABLE_REASON_PROVIDER_NOT_HETZNER,
        nodeBreakdown: nodes.map((n) => ({
          nodeId: n.id,
          type: (n.metadata?.serverType as string) ?? 'unknown',
          cents: null,
          unavailableReason: NOT_AVAILABLE_REASON_PROVIDER_NOT_HETZNER,
        })),
        currency: 'EUR',
        disclaimer: DISCLAIMER,
      };
    }

    try {
      const billing = await this.clusterBilling.getClusterBilling(clusterId);
      const breakdown: NodeCostBreakdown[] = (
        billing.monthToDate?.nodes ?? []
      ).map((n) => ({
        nodeId: n.nodeId,
        type: n.currentServerType,
        cents: null,
        unavailableReason: undefined,
      }));
      const total = this.parseCents(billing.runRate?.monthlyGross);
      const totalAsCents = total === null ? null : Math.round(total);
      if (totalAsCents !== null) {
        const perNode = Math.round(
          totalAsCents / Math.max(1, breakdown.length),
        );
        for (const b of breakdown) b.cents = perNode;
      }
      return {
        clusterMonthlyCents: totalAsCents,
        unavailableReason:
          totalAsCents === null
            ? NOT_AVAILABLE_REASON_NO_PRICING_API
            : undefined,
        nodeBreakdown: breakdown,
        currency: 'EUR',
        disclaimer: DISCLAIMER,
      };
    } catch (err: any) {
      this.logger.warn(
        `Unable to compute cluster cost via Hetzner pricing API: ${err?.message ?? err}`,
      );
      return {
        clusterMonthlyCents: null,
        unavailableReason: `Hetzner pricing API call failed: ${err?.message ?? 'unknown error'}`,
        nodeBreakdown: [],
        currency: 'EUR',
        disclaimer: DISCLAIMER,
      };
    }
  }

  async estimateBackupMonthlyCost(
    clusterId: string,
    profile: EstimateProfile,
    primaryProvider: StorageBackendProvider,
    replicaProvider?: StorageBackendProvider,
    primaryDestinationId?: string,
    replicaDestinationId?: string,
  ): Promise<BackupEstimateResult> {
    const sizeEstimate = await this.estimateBackupDataGb(clusterId);
    const dataGb = sizeEstimate.gb;
    const sizeReason = sizeEstimate.reason;
    const sizeSource = sizeEstimate.source as
      | 'last-backup'
      | 'pvc-requests'
      | undefined;

    const primary = await this.computeDestinationCost(
      dataGb,
      primaryProvider,
      primaryDestinationId,
    );
    const replica =
      profile === 'mirrored' && replicaProvider
        ? await this.computeDestinationCost(
            dataGb,
            replicaProvider,
            replicaDestinationId,
          )
        : undefined;

    const anyUnavailable =
      dataGb === null ||
      primary.centsPerMonth === null ||
      replica?.centsPerMonth === null;

    const total = anyUnavailable
      ? null
      : (primary.centsPerMonth ?? 0) + (replica?.centsPerMonth ?? 0);

    let unavailableReason: string | undefined;
    if (anyUnavailable) {
      unavailableReason =
        dataGb === null
          ? (sizeReason ?? 'Backup data size not detectable')
          : NOT_AVAILABLE_REASON_DESTINATION_NO_COST;
    }

    return {
      estimatedDataGb: dataGb,
      estimatedDataReason: sizeReason,
      estimatedDataSource: sizeSource,
      primary,
      replica,
      totalCentsPerMonth: total,
      unavailableReason,
      currency: 'EUR',
      disclaimer: DISCLAIMER,
    };
  }

  private async computeDestinationCost(
    dataGb: number | null,
    provider: StorageBackendProvider,
    destinationId?: string,
  ): Promise<DestinationCostBreakdown> {
    if (dataGb === null) {
      return {
        provider,
        centsPerMonth: null,
        unavailableReason: 'Data size not detectable — cannot compute cost',
      };
    }
    // 1. Override esplicito sulla BackupDestination (user-set)
    if (destinationId) {
      const dest = await this.destRepo.findById(destinationId);
      if (dest?.costPerGbMonthCents != null) {
        return {
          provider,
          centsPerMonth: Math.round(dataGb * dest.costPerGbMonthCents),
        };
      }
    }
    // 2. Listino provider da env (pricing pubblico, vedere .env.example)
    const pricing = this.providerPricingFromEnv(provider);
    if (pricing) {
      const billable = Math.max(0, dataGb - pricing.includedGb);
      const cents =
        pricing.baseCentsPerMonth + billable * pricing.marginalCentsPerGb;
      return { provider, centsPerMonth: Math.round(cents) };
    }
    return {
      provider,
      centsPerMonth: null,
      unavailableReason: NOT_AVAILABLE_REASON_DESTINATION_NO_COST,
    };
  }

  /**
   * Stima dimensione backup mensile.
   *
   * Strategia (in ordine di preferenza):
   *  1. Ultimo BackupArtifact con sizeBytes valorizzato per il cluster →
   *     dato reale post-backup, è la fonte più accurata.
   *  2. Fallback: sum(PVC.spec.resources.requests.storage) × 1.2 — upper
   *     bound prima del primo backup (usato per il pre-flight estimate).
   *
   * Casi null:
   *  - Cluster non READY e nessun backup precedente → null
   *  - Kubeconfig mancante e nessun backup → null
   *  - Errore lista PVC → null
   */
  private async estimateBackupDataGb(
    clusterId: string,
  ): Promise<{ gb: number | null; reason?: string; source?: string }> {
    const lastArtifact =
      await this.artifactRepo.findLatestWithSizeForCluster(clusterId);
    if (lastArtifact?.sizeBytes) {
      const bytes = Number(lastArtifact.sizeBytes);
      if (Number.isFinite(bytes) && bytes >= 0) {
        return {
          gb: Math.max(0, Math.round(bytes / 1_000_000_000)),
          source: 'last-backup',
        };
      }
    }

    const cluster = await this.clusterRepo.findOne({
      where: { id: clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      return {
        gb: null,
        reason: 'Cluster kubeconfig not available — cannot inspect PVCs',
      };
    }
    if (cluster.status !== ClusterStatus.READY) {
      return {
        gb: null,
        reason: `Cluster not READY (status=${cluster.status}) — cannot inspect PVCs`,
      };
    }

    try {
      const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
      const pvcs = await this.k8s.listResources(
        kubeconfig,
        'PersistentVolumeClaim',
      );
      const totalGb = (pvcs ?? []).reduce((acc: number, pvc: any) => {
        const req = pvc?.spec?.resources?.requests?.storage ?? '0';
        return acc + this.parseStorageToGb(String(req));
      }, 0);
      return { gb: Math.round(totalGb * 1.2), source: 'pvc-requests' };
    } catch (err: any) {
      this.logger.warn(
        `Failed to estimate PVC size for cluster ${clusterId}: ${err?.message}`,
      );
      return {
        gb: null,
        reason: `Failed to list PVCs: ${err?.message ?? 'unknown error'}`,
      };
    }
  }

  private parseStorageToGb(input: string): number {
    const m = /^(\d+(?:\.\d+)?)([KMGTP]i?)?$/.exec(input);
    if (!m) return 0;
    const value = Number.parseFloat(m[1]);
    const unit = m[2] ?? '';
    const map: Record<string, number> = {
      '': 1 / (1024 * 1024 * 1024),
      Ki: 1 / (1024 * 1024),
      Mi: 1 / 1024,
      Gi: 1,
      Ti: 1024,
      Pi: 1024 * 1024,
      K: (1024 * 1024 * 1024) / (1000 * 1000 * 1000),
      M: (1024 * 1024) / (1000 * 1000),
      G: 1024 / 1000,
      T: (1024 * 1024) / 1000,
    };
    return value * (map[unit] ?? 1);
  }

  private parseCents(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return null;
    return Math.round(num);
  }
}
