/**
 * Ownership of an instance relative to the flui installation answering the
 * request. A single cloud provider account can host several independent flui
 * installations, so listing the account's machines is not enough to know which
 * ones belong to *this* installation.
 */
export enum InstanceOwnership {
  /** Belongs to this installation (flui-cluster-id matches a cluster in our DB). */
  SELF = 'self',
  /** Created by another flui installation sharing the same provider account. */
  OTHER_FLUI = 'other-flui',
  /** Not provisioned by flui at all (no managed-by=flui-cloud label). */
  UNMANAGED = 'unmanaged',
}
