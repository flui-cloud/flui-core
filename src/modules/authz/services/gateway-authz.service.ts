import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppEndpointEntity } from '../../dns/entities/app-endpoint.entity';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import {
  IamPrincipal,
  ResourceAttributes,
} from '../../iam/interfaces/iam.types';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { IAM_ROLE, IamRole } from '../../iam/constants/iam-roles';

export interface GatewayAuthzDecision {
  endpoint: AppEndpointEntity;
  appSlug: string;
}

/**
 * The permission a route's `minRole` gate maps to on the target app. `sandbox`
 * is absent by design — it is a tenancy on the platform, not a tier of access to
 * a published application, and an unmapped role denies rather than defaults.
 */
const MIN_ROLE_PERMISSION: Partial<Record<IamRole, string>> = {
  [IAM_ROLE.VIEWER]: IAM_PERMISSION.APP_READ,
  [IAM_ROLE.EDITOR]: IAM_PERMISSION.APP_WRITE,
  [IAM_ROLE.MANAGER]: IAM_PERMISSION.CLUSTER_MANAGE,
};

/**
 * ForwardAuth decision for gateway SSO routes. The route's Middleware points
 * Traefik here; the endpoint (and its gateway config) is resolved from the
 * forwarded host, so the DB stays the single source of truth — nothing is
 * baked into the middleware beyond the address.
 */
@Injectable()
export class GatewayAuthzService {
  private readonly logger = new Logger(GatewayAuthzService.name);

  constructor(
    @InjectRepository(AppEndpointEntity)
    private readonly endpoints: Repository<AppEndpointEntity>,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  async authorize(
    user: AuthenticatedUser,
    forwardedHost: string | undefined,
  ): Promise<GatewayAuthzDecision> {
    const fqdn = this.normalizeHost(forwardedHost);
    if (!fqdn) {
      throw new NotFoundException(
        'forwarded host missing — cannot resolve the gateway route',
      );
    }

    const endpoint = await this.endpoints.findOne({
      where: { fqdn },
      relations: ['application', 'cluster'],
    });
    if (!endpoint) {
      throw new NotFoundException(
        `forwarded host "${fqdn}" does not resolve to a known route`,
      );
    }

    const auth = endpoint.gatewayConfig?.auth;
    if (!auth?.sso) {
      // Defensive: the SSO middleware only exists while sso=true. If a stale
      // middleware still points here, deny rather than silently allow.
      throw new ForbiddenException(
        `route "${fqdn}" has no SSO gate configured`,
      );
    }

    if (auth.minRole && !user.isAdmin) {
      const required = MIN_ROLE_PERMISSION[auth.minRole];
      const allowed = required
        ? await this.policy.check(
            this.principalFrom(user),
            required,
            this.resourceFor(endpoint),
          )
        : false;
      if (!allowed) {
        this.logger.warn(
          `[gateway-authz] deny user=${user.userId} route=${fqdn} minRole=${auth.minRole}`,
        );
        throw new ForbiddenException(
          `access to "${fqdn}" requires at least the ${auth.minRole} role`,
        );
      }
    }

    return {
      endpoint,
      appSlug: endpoint.application?.slug ?? endpoint.serviceName,
    };
  }

  private normalizeHost(host: string | undefined): string | null {
    if (!host) return null;
    const bare = host.split(':')[0].trim().toLowerCase();
    return bare || null;
  }

  private principalFrom(user: AuthenticatedUser): IamPrincipal {
    return {
      userId: user.userId,
      email: user.email,
      role: user.role,
      isAdmin: !!user.isAdmin,
      scopes: user.scopes,
    };
  }

  private resourceFor(endpoint: AppEndpointEntity): ResourceAttributes {
    const app = endpoint.application;
    return {
      slug: app?.slug ?? endpoint.serviceName,
      type: (app?.category as 'system' | 'user') ?? 'user',
      kind: app?.kind,
      clusterId: endpoint.clusterId,
      clusterName: endpoint.cluster?.name,
      provider: endpoint.cluster?.provider,
      tags: app?.tags ?? [],
    };
  }
}
