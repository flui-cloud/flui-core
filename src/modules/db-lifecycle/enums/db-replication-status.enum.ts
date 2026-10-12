export enum DbReplicationStatus {
  INIT = 'init',
  COPYING = 'copying',
  STREAMING = 'streaming',
  PROMOTED = 'promoted',
  FAILED = 'failed',
  ABORTED = 'aborted',
}

export enum DbReplicationKind {
  /** Publication + subscription; the low-level `replicate` path. */
  LOGICAL = 'logical',
  /** Base backup + WAL streaming over a temporary direct link. */
  PHYSICAL = 'physical',
}
