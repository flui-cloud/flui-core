export enum TopologyAppCategory {
  DATABASE = 'database',
  CACHE = 'cache',
  STORAGE = 'storage',
  AUTOMATION = 'automation',
  MEDIA = 'media',
  MONITORING = 'monitoring',
  WEB = 'web',
  BUSINESS = 'business',
  INFRA = 'infra',
}

export enum TopologyAppKind {
  USER = 'user',
  SYSTEM = 'system',
}

export enum TopologyAppStatus {
  RUNNING = 'running',
  WARNING = 'warning',
  ERROR = 'error',
  STOPPED = 'stopped',
}

export enum TopologyServerRole {
  CONTROL_PLANE = 'control-plane',
  WORKER = 'worker',
}

export enum TopologyHealthStatus {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  DOWN = 'down',
}

export enum TopologyScalingMode {
  MANUAL = 'manual',
  HPA = 'hpa',
  DAEMONSET = 'daemonset',
  STATEFULSET = 'statefulset',
}

export enum TopologyEventType {
  APP_STATUS_CHANGED = 'app.status_changed',
  APP_SCALED = 'app.scaled',
  APP_DEPLOYED = 'app.deployed',
  APP_REMOVED = 'app.removed',
  SERVER_ADDED = 'server.added',
  SERVER_REMOVED = 'server.removed',
  SERVER_CAPACITY = 'server.capacity',
  LINKS_CHANGED = 'links.changed',
  HEARTBEAT = 'heartbeat',
}

export enum TopologyClusterType {
  CONTROL = 'control',
  WORKLOAD = 'workload',
  OBSERVABILITY = 'observability',
}

export enum TopologyOverlay {
  TUNNEL = 'tunnel',
  PUBLIC_ADDRESS = 'public-address',
  OFF = 'off',
}

export enum TopologyArchitecture {
  X86 = 'x86',
  ARM = 'arm',
}

export enum TopologyStackType {
  COMPOSED = 'composed',
  STANDALONE = 'standalone',
}

export enum TopologyWorkloadKind {
  DEPLOYMENT = 'deployment',
  STATEFULSET = 'statefulset',
  DAEMONSET = 'daemonset',
}

export enum TopologyExposure {
  PUBLIC = 'public',
  INTERNAL = 'internal',
  CLUSTER = 'cluster',
}

export enum TopologyLinkSource {
  GATEWAY_ROUTE = 'gateway-route',
  ATTACHED_SERVICE = 'attached-service',
  CATALOG_DEPENDENCY = 'catalog-dependency',
  ENV_REFERENCE = 'env-reference',
}

export enum TopologyEndpointKind {
  INTERNET = 'internet',
  APP = 'app',
}

export enum TopologyFluiNetwork {
  ACTIVE = 'active',
  PENDING = 'pending',
  STALE = 'stale',
  NONE = 'none',
}
