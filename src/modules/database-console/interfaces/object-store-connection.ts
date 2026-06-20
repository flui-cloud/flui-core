import { ObjectStoreEngine } from '../engine/object-store-engine';

export interface ObjectStoreResolveInput {
  /** Application id of the installed object store (e.g. a Garage building block). */
  appId: string;
  /** Flui user making the request (audit + future per-user keys). */
  fluiUserId: string;
}

/** Where the in-cluster S3 endpoint lives + the credentials to sign requests. */
export interface ResolvedObjectStoreConnection {
  engine: ObjectStoreEngine;
  target: {
    clusterId: string;
    namespace: string;
    podLabelSelector: string;
    /** S3 API port. */
    port: number;
    /** Admin API port (bucket policy). */
    adminPort: number;
  };
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Admin API bearer token; absent when the store exposes no admin API. */
  adminToken?: string;
  /** Bucket auto-created at install, pre-selected in the browser. */
  defaultBucket?: string;
}

/**
 * NON-SECRET coordinates surfaced to the dashboard. The secret access key is
 * deliberately absent — it never crosses the HTTP API; all object I/O is
 * proxied through the backend over the tunnel.
 */
export interface ObjectStoreConnectionInfo {
  engine: ObjectStoreEngine;
  label: string;
  region: string;
  namespace: string;
  podLabelSelector: string;
  clusterId: string;
  remotePort: number;
  defaultBucket?: string;
}
