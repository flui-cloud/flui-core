import { SearchEngine } from '../engine/search-engine';

export interface SearchResolveInput {
  appId: string;
  fluiUserId: string;
}

export interface ResolvedSearchConnection {
  engine: SearchEngine;
  target: {
    clusterId: string;
    namespace: string;
    podLabelSelector: string;
    port: number;
  };
  username: string;
  password: string;
  useTls: boolean;
}

/** NON-SECRET coordinates surfaced to the dashboard (no password). */
export interface SearchConnectionInfo {
  engine: SearchEngine;
  label: string;
  namespace: string;
  podLabelSelector: string;
  clusterId: string;
  remotePort: number;
  useTls: boolean;
}
