import { SecretsEngine } from '../engine/secrets-engine';

export interface SecretsResolveInput {
  appId: string;
  fluiUserId: string;
}

export interface ResolvedSecretsConnection {
  engine: SecretsEngine;
  /** Install slug — used to locate the K8s Secret holding the token/unseal key. */
  slug: string;
  target: {
    clusterId: string;
    namespace: string;
    podLabelSelector: string;
    port: number;
  };
  useTls: boolean;
  mount: string;
}

export interface SecretsConnectionInfo {
  engine: SecretsEngine;
  label: string;
  namespace: string;
  podLabelSelector: string;
  clusterId: string;
  remotePort: number;
  mount: string;
}
