export enum AppEventType {
  // Deploy lifecycle
  DEPLOY = 'deploy',
  ROLLBACK = 'rollback',

  // Runtime operations
  SCALE = 'scale',
  RESOURCE_UPDATE = 'resource_update',
  RESTART = 'restart',

  // Lifecycle
  START = 'start',
  STOP = 'stop',
  CONFIG_UPDATE = 'config_update',

  // System events
  RECONCILED = 'reconciled',
  CREATED = 'created',
  DELETE = 'delete',

  // What became of an action held for the maintenance window
  MAINTENANCE = 'maintenance',
}

export enum AppEventActorType {
  USER = 'user',
  SYSTEM = 'system',
  SCHEDULER = 'scheduler',
  API = 'api',
}

export interface AppEventActor {
  type: AppEventActorType;
  id?: string;
  name?: string;
}
