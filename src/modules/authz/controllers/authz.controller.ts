import {
  All,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { InternalAppAuthzService } from '../services/internal-app-authz.service';
import { GatewayAuthzService } from '../services/gateway-authz.service';
import {
  GATEWAY_SSO_CALLBACK,
  GatewaySsoService,
} from '../services/gateway-sso.service';
import { OptionalAuth } from '../../auth/decorators/optional-auth.decorator';
import { GatewaySsoCodeDto } from '../dto/gateway-sso-code.dto';
import {
  InternalAppAuditService,
  InternalAppAuditReason,
} from '../services/internal-app-audit.service';

interface ForwardAuthRequest {
  user?: AuthenticatedUser;
  headers: Record<string, string | string[] | undefined>;
}

function headerValue(
  req: ForwardAuthRequest,
  name: string,
): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * ForwardAuth endpoint called by the Ingress controller in front of every
 * internal app. The incoming request carries the original context via the
 * standard `X-Forwarded-*` / `X-Original-*` headers set by nginx-ingress /
 * Traefik's ForwardAuth middleware. The JWT travels in the `flui_session`
 * cookie (cross-sub-domain) or, in dev/testing, as a Bearer token — both are
 * accepted by the global `JwtAuthGuard`.
 *
 * Response:
 *  - 200 OK with `X-Auth-User`, `X-Auth-Email` headers → Ingress forwards to
 *    the backing Service.
 *  - 401 Unauthorized → Ingress redirects to `auth-signin` (dashboard login).
 *  - 403 Forbidden / 404 Not Found → the target is not an internal app, or
 *    does not exist, or the user lacks access.
 */
@ApiTags('authz')
@Controller('authz')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AuthzController {
  private readonly logger = new Logger(AuthzController.name);

  constructor(
    private readonly authzService: InternalAppAuthzService,
    private readonly gatewayAuthzService: GatewayAuthzService,
    private readonly auditService: InternalAppAuditService,
    private readonly gatewaySso: GatewaySsoService,
  ) {}

  @All('gateway')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'ForwardAuth decision for gateway SSO routes',
    description:
      'Called by Traefik on every request to a route whose gateway config enables SSO. Validates the Flui session (JWT in cookie or Bearer), resolves the route from the forwarded host and, when the route sets a minRole, asks the PolicyEngine whether the user holds it on the target application.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Access allowed. Response carries `X-Auth-User`, `X-Auth-Email` and `X-Auth-App` headers.',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid session.' })
  @ApiResponse({
    status: 403,
    description: 'Route has no SSO gate or the user lacks the required role.',
  })
  @ApiResponse({
    status: 404,
    description: 'Forwarded host did not resolve to a known route.',
  })
  async gateway(
    @Req() req: { user?: AuthenticatedUser },
    @Res({ passthrough: true }) res: Response,
    @Headers('x-forwarded-host') forwardedHost: string | undefined,
  ): Promise<void> {
    const user = req.user;
    if (!user) throw new UnauthorizedException();

    const { appSlug } = await this.gatewayAuthzService.authorize(
      user,
      forwardedHost,
    );

    res.setHeader('X-Auth-User', user.userId);
    if (user.email) res.setHeader('X-Auth-Email', user.email);
    res.setHeader('X-Auth-App', appSlug);
  }

  @All('gateway/:endpointId')
  @OptionalAuth()
  @ApiOperation({
    summary: 'ForwardAuth decision for one gateway SSO route',
    description:
      "Called by Traefik on every request to a route whose gateway config enables SSO; the route id is part of the address the route was published with. Accepts a Flui credential (Bearer) or the route's own sign-in cookie and, when the route sets a minRole, asks the PolicyEngine whether the user holds it on the target application. A browser without either is redirected to sign in; any other client gets 401.",
  })
  @ApiResponse({
    status: 200,
    description:
      'Access allowed. Response carries `X-Auth-User`, `X-Auth-Email` and `X-Auth-App` headers.',
  })
  @ApiResponse({
    status: 302,
    description:
      'A browser without a session is sent to sign in, or back to the page it asked for once the sign-in code is spent.',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid session.' })
  @ApiResponse({
    status: 403,
    description: 'Route has no SSO gate or the user lacks the required role.',
  })
  @ApiResponse({ status: 404, description: 'The route does not exist.' })
  async gatewayRoute(
    @Req() req: ForwardAuthRequest,
    @Res() res: Response,
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
  ): Promise<void> {
    const forwardedUri = headerValue(req, 'x-forwarded-uri');
    const [path, query = ''] = (forwardedUri ?? '').split('?');

    if (path.endsWith(GATEWAY_SSO_CALLBACK)) {
      const { cookie, returnUrl } = await this.gatewaySso.exchangeCode(
        endpointId,
        new URLSearchParams(query).get('code'),
      );
      res.setHeader('Set-Cookie', cookie);
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(HttpStatus.FOUND, returnUrl);
      return;
    }

    const user =
      req.user ??
      (await this.gatewaySso.userFromCookie(
        endpointId,
        headerValue(req, 'cookie'),
      ));
    if (!user) {
      if (!this.isBrowserNavigation(req)) throw new UnauthorizedException();
      const fqdn = await this.gatewaySso.endpointFqdn(endpointId);
      const back =
        GatewaySsoService.originalUrl(fqdn, forwardedUri) ?? `https://${fqdn}/`;
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(
        HttpStatus.FOUND,
        this.gatewaySso.loginUrl(endpointId, back),
      );
      return;
    }

    const { appSlug } = await this.gatewayAuthzService.authorizeRoute(
      user,
      endpointId,
    );

    res.setHeader('X-Auth-User', user.userId);
    if (user.email) res.setHeader('X-Auth-Email', user.email);
    res.setHeader('X-Auth-App', appSlug);
    res.status(HttpStatus.OK).end();
  }

  @Post('gateway/:endpointId/sso-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One-time sign-in code for a gateway route',
    description:
      "Called by the dashboard for a signed-in person: returns the address on the route's own host that exchanges the code for the route's sign-in cookie. Refused unless the person may open the route and the return address is on the route's host.",
  })
  async gatewaySsoCode(
    @Req() req: { user?: AuthenticatedUser },
    @Param('endpointId', ParseUUIDPipe) endpointId: string,
    @Body() body: GatewaySsoCodeDto,
  ): Promise<{ redirect: string }> {
    if (!req.user) throw new UnauthorizedException();
    return this.gatewaySso.issueCode(req.user, endpointId, body.returnUrl);
  }

  /**
   * A person's browser opening a page, as opposed to a script or an API
   * client: those keep getting a 401 they can act on, not a login page.
   */
  private isBrowserNavigation(req: ForwardAuthRequest): boolean {
    const method = (
      headerValue(req, 'x-forwarded-method') ?? 'GET'
    ).toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return false;
    if (headerValue(req, 'authorization')) return false;
    return (headerValue(req, 'accept') ?? '').includes('text/html');
  }

  @All('internal-app')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'ForwardAuth decision for internal apps',
    description:
      'Called by the user-cluster Ingress on every request to a `*.internal.*` host. Validates the Flui session (JWT in cookie or Bearer) and checks that the targeted app exists and has exposure=internal. Emits an audit event on each call.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Access allowed. Response carries `X-Auth-User` and `X-Auth-Email` headers for downstream auto-login.',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid session.' })
  @ApiResponse({
    status: 403,
    description: 'Target is not an internal app or user not allowed.',
  })
  @ApiResponse({
    status: 404,
    description:
      'Forwarded host did not resolve to a known app (bad sub-domain or app removed).',
  })
  async internalApp(
    @Req() req: ForwardAuthRequest,
    @Res({ passthrough: true }) res: Response,
    @Ip() clientIp: string,
  ): Promise<void> {
    const startedAt = Date.now();
    const user = req.user;
    const forwardedHost = headerValue(req, 'x-forwarded-host');
    const forwardedUri = headerValue(req, 'x-forwarded-uri');
    const forwardedMethod = headerValue(req, 'x-forwarded-method');
    const originalUrl = headerValue(req, 'x-original-url');
    const userAgent = headerValue(req, 'user-agent');
    const path = forwardedUri || originalUrl;
    const method = forwardedMethod;
    this.logger.debug(
      `[ForwardAuth] host=${forwardedHost} user=${user?.userId ?? 'none'} cookie=${headerValue(req, 'cookie') ? 'present' : 'absent'}`,
    );

    if (!user) {
      // JwtAuthGuard should have thrown already; this is defence-in-depth.
      this.auditService.emit({
        result: 'deny',
        reason: 'session_invalid',
        host: forwardedHost,
        path,
        method,
        clientIp,
        userAgent,
        latencyMs: Date.now() - startedAt,
      });
      throw new UnauthorizedException();
    }

    try {
      const { app, appSlug } = await this.authzService.authorize({
        forwardedHost,
        forwardedUri,
        forwardedMethod,
        clientIp,
        userAgent,
      });

      res.setHeader('X-Auth-User', user.userId);
      if (user.email) res.setHeader('X-Auth-Email', user.email);
      res.setHeader('X-Auth-App', appSlug);

      this.auditService.emit({
        result: 'allow',
        reason: null,
        userId: user.userId,
        userEmail: user.email,
        appId: app.id,
        appSlug,
        clusterId: app.clusterId,
        host: forwardedHost,
        path,
        method,
        clientIp,
        userAgent,
        latencyMs: Date.now() - startedAt,
      });
    } catch (err) {
      let reason: InternalAppAuditReason;
      if (err instanceof NotFoundException) {
        reason = err.message.includes('forwarded host')
          ? 'missing_forwarded_host'
          : 'app_not_found';
      } else if (err instanceof ForbiddenException) {
        reason = 'not_internal';
      } else {
        reason = 'session_invalid';
      }
      this.auditService.emit({
        result: 'deny',
        reason,
        userId: user.userId,
        userEmail: user.email,
        host: forwardedHost,
        path,
        method,
        clientIp,
        userAgent,
        latencyMs: Date.now() - startedAt,
      });
      throw err;
    }
  }
}
