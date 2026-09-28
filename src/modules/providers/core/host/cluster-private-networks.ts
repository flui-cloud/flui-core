import { In, Repository } from 'typeorm';
import { ClusterEntity } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { VNetSubnetEntity } from 'src/modules/infrastructure/vnets/entities/vnet-subnet.entity';

const CIDR_RE = /^[0-9a-fA-F:.]+\/\d{1,3}$/;
const ANYWHERE_CIDRS = new Set(['0.0.0.0/0', '::/0']);

interface VNetRef {
  vnetId?: string | null;
  subnetId?: string | null;
}

export function isUsablePrivateCidr(cidr: string | null | undefined): boolean {
  const value = cidr?.trim();
  return !!value && CIDR_RE.test(value) && !ANYWHERE_CIDRS.has(value);
}

/** The node networks an operator declared for a BYOS cluster. */
export function declaredNodeNetworks(cluster: ClusterEntity): string[] {
  const declared = (
    cluster.metadata as { byos?: { nodeNetwork?: string | string[] } }
  )?.byos?.nodeNetwork;
  const declaredList = Array.isArray(declared)
    ? declared
    : (declared ?? '').split(',');
  return declaredList
    .map((raw) => raw.trim())
    .filter((cidr) => cidr && CIDR_RE.test(cidr));
}

export interface VnetSubnetRanges {
  ranges: string[];
  /** The cluster points at a subnet, but none of them carries a usable range. */
  referencedWithoutRange: boolean;
  error?: string;
}

/**
 * The ranges of the VNet subnet(s) a cluster and its nodes are attached to.
 *
 * Shared by everything that admits a cluster's siblings by source network, so
 * the host firewall and the shared storage export can never disagree about
 * what the cluster's private network is.
 */
export async function readVnetSubnetRanges(
  cluster: ClusterEntity,
  subnetRepository: Pick<Repository<VNetSubnetEntity>, 'find'>,
): Promise<VnetSubnetRanges> {
  const refs: VNetRef[] = [
    (cluster.metadata as { vnetConfig?: VNetRef })?.vnetConfig ?? {},
  ];
  for (const node of cluster.nodes ?? []) {
    refs.push(
      (node.metadata as { vnetAttachment?: VNetRef })?.vnetAttachment ?? {},
      { subnetId: node.subnetId },
    );
  }

  const subnetIds = new Set(
    refs.map((r) => r.subnetId).filter((id): id is string => !!id),
  );
  const vnetIds = new Set(
    refs.map((r) => r.vnetId).filter((id): id is string => !!id),
  );
  if (subnetIds.size === 0 && vnetIds.size === 0) {
    return { ranges: [], referencedWithoutRange: false };
  }

  try {
    let subnets = subnetIds.size
      ? await subnetRepository.find({ where: { id: In([...subnetIds]) } })
      : [];
    // Clusters attached before subnetId was recorded only know their VNet.
    if (subnets.length === 0 && vnetIds.size > 0) {
      subnets = await subnetRepository.find({
        where: { vnetId: In([...vnetIds]) },
      });
    }
    const ranges = subnets
      .map((s) => s.ipRange?.trim())
      .filter((r): r is string => isUsablePrivateCidr(r));
    return { ranges, referencedWithoutRange: ranges.length === 0 };
  } catch (error) {
    return {
      ranges: [],
      referencedWithoutRange: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
