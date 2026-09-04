export enum BackupEngineClass {
  VOLUME = 'volume',
  DATABASE = 'database',
  PLATFORM = 'platform',
  /**
   * One volume, copied on demand — the copy-pod primitive behind
   * `flui backup take`. Its sink decides where the copy lands: an S3
   * destination (durable, survives the cluster) or a sibling PVC in the
   * cluster (fast, dies with the application).
   */
  VOLUME_COPY = 'volume_copy',
}
