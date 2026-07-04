export enum DbReplicationStatus {
  INIT = 'init',
  COPYING = 'copying',
  STREAMING = 'streaming',
  PROMOTED = 'promoted',
  FAILED = 'failed',
  ABORTED = 'aborted',
}
