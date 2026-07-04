export enum DemoLoopState {
  IDLE = 'idle',
  MIGRATING = 'migrating',
  DRAINING = 'draining',
  FAILED = 'failed',
}

/**
 * FIXED_PAIR alternates the app between two pre-registered workload clusters.
 * EPHEMERAL (provision target → migrate → drain → destroy source, §9's
 * one-cluster-at-rest ideal) is modelled but not yet wired — [FR].
 */
export enum DemoProvisionMode {
  FIXED_PAIR = 'fixed-pair',
  EPHEMERAL = 'ephemeral',
}
