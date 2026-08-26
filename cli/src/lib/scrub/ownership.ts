/**
 * How to tell a resource Flui created from one the customer already had.
 *
 * This is the whole safety of `flui env scrub`, so it reads the marks the
 * product *already* writes rather than inventing a new one:
 *
 *  - **the ownership label.** `LabelService` puts `managed-by=flui-cloud` on
 *    every server, volume, firewall and VNet it creates, on Hetzner as a label
 *    and on Scaleway as a `key=value` tag. It is the same mark
 *    `listFluiManagedVolumes` filters on and the same one the firewall
 *    reconciler trusts.
 *  - **the cluster stamp.** Servers and bootstrap keys additionally carry
 *    `flui-cluster-id=<uuid>`, which separates *this* installation from every
 *    other Flui cluster on the same account.
 *  - **the minted name.** Scaleway's IAM SSH keys accept no tags at all —
 *    `createSSHKey` says so in as many words — so a bootstrap key there carries
 *    no label whatsoever. What it does carry is a name this CLI minted:
 *    `flui-bootstrap-<cluster uuid>-<node>`. A UUID we generated is evidence of
 *    the same order as a label we wrote, and refusing to recognise it would
 *    leave a paid resource on the account with no tool able to name it.
 *
 * Nothing else counts. A resource with none of these marks is somebody else's,
 * whatever a list says about it.
 */

export const FLUI_OWNER_LABEL = 'managed-by';
export const FLUI_OWNER_VALUE = 'flui-cloud';
export const FLUI_CLUSTER_LABEL = 'flui-cluster-id';

/**
 * `flui-bootstrap-<uuid>-<node name>`, minted by
 * `CliClusterCreatorService.generateBootstrapKey`. Anchored at both ends of the
 * UUID so a customer key merely *starting* with the same words cannot pass.
 */
const MINTED_BOOTSTRAP_KEY =
  /^flui-bootstrap-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-.+$/i;

export type OwnershipEvidence = 'label' | 'minted-name' | 'none';

export interface Ownership {
  /** True only when the product itself left a mark on this resource. */
  readonly owned: boolean;
  readonly evidence: OwnershipEvidence;
  /** The installation it belongs to, when the mark says so. */
  readonly clusterId: string | null;
}

export interface MarkedResource {
  readonly kind: string;
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}

export function readOwnership(resource: MarkedResource): Ownership {
  const labelled = resource.labels[FLUI_OWNER_LABEL] === FLUI_OWNER_VALUE;
  const stamped = resource.labels[FLUI_CLUSTER_LABEL];
  if (labelled) {
    return {
      owned: true,
      evidence: 'label',
      clusterId: nonEmpty(stamped),
    };
  }

  if (resource.kind === 'ssh-key') {
    const minted = MINTED_BOOTSTRAP_KEY.exec(resource.name);
    if (minted) {
      return {
        owned: true,
        evidence: 'minted-name',
        clusterId: minted[1].toLowerCase(),
      };
    }
  }

  return { owned: false, evidence: 'none', clusterId: nonEmpty(stamped) };
}

export function describeEvidence(evidence: OwnershipEvidence): string {
  switch (evidence) {
    case 'label':
      return `carries ${FLUI_OWNER_LABEL}=${FLUI_OWNER_VALUE}`;
    case 'minted-name':
      return 'name was minted by the Flui bootstrap';
    default:
      return 'carries no Flui ownership mark';
  }
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
