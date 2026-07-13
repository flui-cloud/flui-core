import { IamRole } from '../../iam/constants/iam-roles';

/**
 * Per-route L7 gateway policies, compiled by the endpoint reconciler into
 * Traefik Middleware CRDs referenced from the endpoint's Ingress. Absence of
 * a config (or of a field) means today's default behavior: plain route from
 * the endpoint fqdn, auto TLS, no policies.
 */
export interface GatewayAuthPolicy {
  /** Gate every request through Flui SSO (forwardAuth → /authz/gateway). */
  sso: boolean;
  /** Minimum IAM role on the app required to pass (evaluated by the PolicyEngine). */
  minRole?: IamRole;
}

export interface GatewayRateLimitPolicy {
  /** Sustained requests per period (Traefik rateLimit.average). */
  average: number;
  /** Burst capacity above the average (Traefik rateLimit.burst). */
  burst?: number;
  /** Averaging window as a Go duration, e.g. "1s", "1m". Defaults to 1s. */
  period?: string;
}

export interface EndpointGatewayConfig {
  /** PathPrefix match for the route. Defaults to "/". */
  path?: string;
  auth?: GatewayAuthPolicy;
  rateLimit?: GatewayRateLimitPolicy;
  /** CIDR allowlist; when set, requests from other sources are rejected. */
  allowIps?: string[];
}
