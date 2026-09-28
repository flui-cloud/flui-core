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
  principalFromUser,
} from '../../iam/interfaces/iam.types';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { IAM_ROLE, IamRole } from '../../iam/constants/iam-roles';
import { EndpointType } from '../../dns/enums/endpoint-type.enum';
import { ApplicationExposure } from '../../applications/enums/application-exposure.enum';

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
  [IAM_ROLE.OPERATOR]: IAM_PERMISSION.APP_WRITE,
  [IAM_ROLE.MAINTAINER]: IAM_PERMISSION.CLUSTER_MANAGE,
};

/**
 * ForwardAuth decision for gateway SSO routes. The route's Middleware points
 * Traefik here with the route id in the address; its gateway config is read
 * from the DB, so nothing is baked into the middleware beyond the address.
 */
@Injectable()
export class GatewayAuthzService {
  private readonly logger = new Logger(GatewayAuthzService.name);

  constructor(
    @InjectRepository(AppEndpointEntity)
    private readonly endpoints: Repository<AppEndpointEntity>,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  /**
   * The route named by the middleware's own address. Its identity never comes
   * from a header: a forwarded host is rewritten by any proxy the check passes
   * through.
   */
  async authorizeRoute(
    user: AuthenticatedUser,
    endpointId: string,
  ): Promise<GatewayAuthzDecision> {
    const endpoint = await this.endpoints.findOne({
      where: { id: endpointId },
      relations: ['application', 'cluster'],
    });
    if (!endpoint) {
      throw new NotFoundException(`route ${endpointId} does not exist`);
    }
    return this.decide(user, endpoint);
  }

  /** Middlewares written before the route id was part of the address. */
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
    return this.decide(user, endpoint);
  }

  private async decide(
    user: AuthenticatedUser,
    endpoint: AppEndpointEntity,
  ): Promise<GatewayAuthzDecision> {
    if (endpoint.endpointType === EndpointType.INTERNAL) {
      return this.decideInternal(user, endpoint);
    }
    const fqdn = endpoint.fqdn;
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

  /**
   * An internal app is open to the people who may read it — asked again on
   * every request, so a revoked grant closes it at once.
   */
  private async decideInternal(
    user: AuthenticatedUser,
    endpoint: AppEndpointEntity,
  ): Promise<GatewayAuthzDecision> {
    const app = endpoint.application;
    if (app?.exposure !== ApplicationExposure.INTERNAL) {
      throw new ForbiddenException(`"${endpoint.fqdn}" is not an internal app`);
    }
    const allowed =
      user.isAdmin ||
      (await this.policy.check(
        this.principalFrom(user),
        IAM_PERMISSION.APP_READ,
        this.resourceFor(endpoint),
      ));
    if (!allowed) {
      this.logger.warn(
        `[gateway-authz] deny user=${user.userId} internal=${endpoint.fqdn}`,
      );
      throw new ForbiddenException(
        `your account does not have access to "${app.slug}"`,
      );
    }
    return { endpoint, appSlug: app.slug };
  }

  private normalizeHost(host: string | undefined): string | null {
    if (!host) return null;
    const bare = host.split(':')[0].trim().toLowerCase();
    return bare || null;
  }

  private principalFrom(user: AuthenticatedUser): IamPrincipal {
    return principalFromUser(user);
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
