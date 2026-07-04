export enum DestinationHealthStatus {
  UNKNOWN = 'unknown',
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  FAILED = 'failed',
}

export enum EncryptionMode {
  FLUI_MANAGED = 'flui_managed',
  BYO_PASSPHRASE = 'byo_passphrase',
  NONE = 'none',
  // Sealed to an operator-held age recipient; the master cannot decrypt it (platform class).
  OPERATOR = 'operator',
}
