import { FulltextEngine } from '../engine/fulltext-engine';

export interface FulltextResolveInput {
  appId: string;
  fluiUserId: string;
}

export interface FulltextTarget {
  clusterId: string;
  namespace: string;
  podLabelSelector: string;
  port: number;
}

export interface ResolvedFulltextConnection {
  engine: FulltextEngine;
  target: FulltextTarget;
  /** Master/API key read from the install's Secret. */
  apiKey?: string;
}

export interface FulltextConnectionInfo {
  engine: FulltextEngine;
  label: string;
  namespace: string;
  podLabelSelector: string;
  clusterId: string;
  remotePort: number;
}
