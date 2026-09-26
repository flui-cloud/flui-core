export enum ApplicationStatus {
  PENDING = 'pending',
  /**
   * Workflow has been committed to GitHub and a run is (or will be) in progress.
   * Flui is waiting either for the workflow webhook to notify build completion,
   * or for the background build watcher to poll GitHub and discover it.
   * Transitions to PROVISIONING once an imageRef is available and a deploy job
   * is queued, or to FAILED on build failure / timeout.
   */
  AWAITING_BUILD = 'awaiting_build',
  PROVISIONING = 'provisioning',
  WAITING_FOR_ROOM = 'waiting_for_room',
  RUNNING = 'running',
  DEGRADED = 'degraded',
  STOPPED = 'stopped',
  UPDATING = 'updating',
  ROLLING_BACK = 'rolling_back',
  FAILED = 'failed',
  DELETING = 'deleting',
  DELETED = 'deleted',
}
