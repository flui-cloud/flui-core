import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationExposure } from '../../applications/enums/application-exposure.enum';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationAccessService } from '../../applications/services/application-access.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ceilingWithholds } from '../../auth/utils/credential-ceiling.util';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import { principalFromUser } from '../../iam/interfaces/iam.types';

export interface InternalAppAuthzRequest {
  forwardedHost: string | undefined;
  forwardedUri: string | undefined;
  forwardedMethod: string | undefined;
  clientIp: string | undefined;
  userAgent: string | undefined;
}

export interface InternalAppAuthzDecision {
  app: ApplicationEntity;
  appSlug: string;
}

export class InternalAppNotPermittedException extends ForbiddenException {}

/**
 * Resolves the internal app targeted by a ForwardAuth subrequest and decides
 * whether the current user is allowed to reach it: `app:read` on that app and
 * `data:access`, since opening an internal app shows what it holds.
 */
@Injectable()
export class InternalAppAuthzService {
  private readonly logger = new Logger(InternalAppAuthzService.name);

  constructor(
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly access: ApplicationAccessService,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  /**
   * Given the `Host` the browser used (as reported by the Ingress via
   * `X-Forwarded-Host`), extract the app slug. Convention: slug is the first
   * DNS label of a host of the form `<slug>.internal.<rest>`.
   */
  extractSlugFromHost(host: string | undefined): string | null {
    if (!host) return null;
    const bare = host.split(':')[0].toLowerCase();
    const labels = bare.split('.');
    if (labels.length < 3) return null;
    if (labels[1] !== 'internal') return null;
    const slug = labels[0];
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(slug)) return null;
    return slug;
  }

  async authorize(
    req: InternalAppAuthzRequest,
  ): Promise<InternalAppAuthzDecision> {
    const slug = this.extractSlugFromHost(req.forwardedHost);
    if (!slug) {
      throw new NotFoundException(
        'forwarded host does not resolve to an internal app',
      );
    }
    const app = await this.applicationsRepository.findBySlug(slug);
    if (!app) {
      throw new NotFoundException(`app "${slug}" not found`);
    }
    if (app.exposure !== ApplicationExposure.INTERNAL) {
      throw new ForbiddenException(
        `app "${slug}" is not an internal app (exposure=${app.exposure})`,
      );
    }
    return { app, appSlug: slug };
  }

  async assertMayOpen(
    user: AuthenticatedUser,
    app: ApplicationEntity,
  ): Promise<void> {
    const permitted =
      !ceilingWithholds(user, IAM_PERMISSION.APP_READ) &&
      !ceilingWithholds(user, IAM_PERMISSION.DATA_ACCESS) &&
      (await this.access.can(user, IAM_PERMISSION.APP_READ, app)) &&
      (await this.policy.check(
        principalFromUser(user),
        IAM_PERMISSION.DATA_ACCESS,
      ));
    if (!permitted) {
      throw new InternalAppNotPermittedException(
        `Not allowed to open internal app "${app.slug}"`,
      );
    }
  }
}
