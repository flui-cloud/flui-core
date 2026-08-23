import { Injectable } from '@nestjs/common';
import { AppEndpointEntity } from '../entities/app-endpoint.entity';
import { EndpointGatewayConfig } from '../interfaces/endpoint-gateway-config.interface';
import { ENDPOINT_ID_LABEL } from '../constants/endpoint-labels';

export interface CompiledGatewayMiddleware {
  name: string;
  manifest: Record<string, unknown>;
  /** Traefik CRD-provider reference: `<namespace>-<name>@kubernetescrd`. */
  ref: string;
}

export interface CompiledGateway {
  middlewares: CompiledGatewayMiddleware[];
  refs: string[];
  /** PathPrefix the Ingress rule should match. */
  path: string;
}

const GATEWAY_MIDDLEWARE_SUFFIXES = ['allowlist', 'ratelimit', 'sso'] as const;

/**
 * Compiles an endpoint's gateway policies into Traefik Middleware CRDs.
 * Deterministic naming (`flui-gw-<endpointIdPrefix>-<policy>`) makes both
 * adoption and cleanup mechanical: the reconciler applies the desired set and
 * deletes the fixed complement. Chain order is cheapest-rejection-first:
 * ipAllowList → rateLimit → forwardAuth(SSO).
 */
@Injectable()
export class GatewayMiddlewareCompilerService {
  middlewareName(
    endpoint: Pick<AppEndpointEntity, 'id'>,
    policy: (typeof GATEWAY_MIDDLEWARE_SUFFIXES)[number],
  ): string {
    return `flui-gw-${endpoint.id.split('-')[0]}-${policy}`;
  }

  allMiddlewareNames(endpoint: Pick<AppEndpointEntity, 'id'>): string[] {
    return GATEWAY_MIDDLEWARE_SUFFIXES.map((p) =>
      this.middlewareName(endpoint, p),
    );
  }

  /**
   * Build the desired middleware set for an endpoint. `forwardAuthAddress` is
   * required only when the config enables SSO — the caller resolves it and
   * fails closed when it cannot.
   */
  compile(
    endpoint: Pick<AppEndpointEntity, 'id' | 'k8sNamespace'>,
    config: EndpointGatewayConfig | null | undefined,
    forwardAuthAddress?: string,
  ): CompiledGateway {
    const middlewares: CompiledGatewayMiddleware[] = [];

    if (config?.allowIps?.length) {
      middlewares.push(
        this.build(endpoint, 'allowlist', {
          ipAllowList: { sourceRange: config.allowIps },
        }),
      );
    }

    if (config?.rateLimit?.average) {
      const rateLimit: Record<string, unknown> = {
        average: config.rateLimit.average,
      };
      if (config.rateLimit.burst !== undefined) {
        rateLimit.burst = config.rateLimit.burst;
      }
      if (config.rateLimit.period) {
        rateLimit.period = config.rateLimit.period;
      }
      middlewares.push(this.build(endpoint, 'ratelimit', { rateLimit }));
    }

    if (config?.auth?.sso) {
      if (!forwardAuthAddress) {
        throw new Error(
          'Gateway SSO requested but no forwardAuth address available',
        );
      }
      middlewares.push(
        this.build(endpoint, 'sso', {
          forwardAuth: {
            address: forwardAuthAddress,
            trustForwardHeader: true,
            authResponseHeaders: ['X-Auth-User', 'X-Auth-Email', 'X-Auth-App'],
          },
        }),
      );
    }

    return {
      middlewares,
      refs: middlewares.map((m) => m.ref),
      path: this.normalizePath(config?.path),
    };
  }

  normalizePath(path: string | undefined): string {
    if (!path || path === '/') return '/';
    const withSlash = path.startsWith('/') ? path : `/${path}`;
    return withSlash.replace(/\/+$/, '') || '/';
  }

  private build(
    endpoint: Pick<AppEndpointEntity, 'id' | 'k8sNamespace'>,
    policy: (typeof GATEWAY_MIDDLEWARE_SUFFIXES)[number],
    spec: Record<string, unknown>,
  ): CompiledGatewayMiddleware {
    const name = this.middlewareName(endpoint, policy);
    return {
      name,
      manifest: {
        apiVersion: 'traefik.io/v1alpha1',
        kind: 'Middleware',
        metadata: {
          name,
          namespace: endpoint.k8sNamespace,
          labels: {
            'managed-by': 'flui-cloud',
            'flui-resource-type': 'gateway-middleware',
            [ENDPOINT_ID_LABEL]: endpoint.id,
          },
        },
        spec,
      },
      ref: `${endpoint.k8sNamespace}-${name}@kubernetescrd`,
    };
  }
}
