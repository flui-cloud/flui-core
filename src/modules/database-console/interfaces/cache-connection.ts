import { CacheEngine } from '../engine/cache-engine';

export interface CacheResolveInput {
  appId: string;
  fluiUserId: string;
}

export interface ResolvedCacheConnection {
  engine: CacheEngine;
  target: {
    clusterId: string;
    namespace: string;
    podLabelSelector: string;
    port: number;
  };
}

export interface CacheConnectionInfo {
  engine: CacheEngine;
  label: string;
  namespace: string;
  podLabelSelector: string;
  clusterId: string;
  remotePort: number;
}
