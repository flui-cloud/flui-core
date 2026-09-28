import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { agentSurfaceOf } from '../../auth/utils/actor-surface';
import { Sensitivity } from '../constants/sensitivity';
import {
  CREDENTIAL_PLACEHOLDER,
  MaskSessionContext,
  fakeValueFor,
} from '../utils/fake-value.util';
import { resolveMaskSaltSecret } from '../utils/mask-salt.util';
import { DtoClass, SensitivityRegistry } from '../sensitivity.registry';
import { maskUntyped } from '../utils/untyped-mask.util';
import {
  dtoPropertyKeys,
  dtoPropertyType,
  isDtoClass,
  resolveRouteResponseType,
} from '../utils/swagger-metadata.util';

interface MaskRequest extends Request {
  user?: AuthenticatedUser;
}

interface FieldPlan {
  isArray: boolean;
  /** Set when this field's type is itself a DTO class — recurse instead of classifying. */
  nested?: ClassPlan;
  sensitivity?: Sensitivity;
  /** `CREDENTIAL` fields only. */
  conditionalCredential?: boolean;
  screenOnly?: boolean;
}
type ClassPlan = ReadonlyMap<string, FieldPlan>;

// DTO shape never changes at runtime, so the plan is built once per class.
const planCache = new Map<DtoClass, ClassPlan>();

function planFor(
  dtoClass: DtoClass,
  registry: SensitivityRegistry,
  building: Set<DtoClass> = new Set(),
): ClassPlan {
  const cached = planCache.get(dtoClass);
  if (cached) return cached;
  // A DTO nesting itself, directly or transitively, would recurse forever
  // building the plan; an empty plan for the inner call breaks the cycle.
  if (building.has(dtoClass)) return new Map();
  building.add(dtoClass);

  const sensitivities = registry.getSensitivities(dtoClass);

  const plan = new Map<string, FieldPlan>();
  for (const key of dtoPropertyKeys(dtoClass)) {
    const [resolvedType, isArray] = dtoPropertyType(dtoClass, key);

    plan.set(
      key,
      isDtoClass(resolvedType)
        ? { isArray, nested: planFor(resolvedType, registry, building) }
        : {
            isArray,
            sensitivity: sensitivities.get(key),
            conditionalCredential: registry.isConditionalCredential(
              dtoClass,
              key,
            ),
            screenOnly: registry.isScreenOnly(dtoClass, key),
          },
    );
  }

  building.delete(dtoClass);
  planCache.set(dtoClass, plan);
  return plan;
}

interface MaskRuntimeContext {
  maskOn: boolean;
  /** The browser's screen-share toggle, as opposed to an agent's tool call. */
  screenShare: boolean;
  session: MaskSessionContext;
  saltSecret: string;
}

/**
 * Substitutes every string leaf reachable directly off a field's raw value:
 * the value itself, each element of a string array, or — for a flat key/value
 * map — every value with its key untouched. That last shape generalizes what
 * `SENSITIVE_MASK` already does per-key in `app-config.service.ts` rather
 * than introducing a second masking convention.
 */
function substituteScalar(raw: unknown, fn: (real: string) => string): unknown {
  if (Array.isArray(raw)) {
    return raw.map((el) => (typeof el === 'string' ? fn(el) : el));
  }
  if (typeof raw === 'string') return fn(raw);
  if (raw && typeof raw === 'object' && !(raw instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(
      raw as Record<string, unknown>,
    )) {
      out[key] = typeof entryValue === 'string' ? fn(entryValue) : entryValue;
    }
    return out;
  }
  return raw;
}

/**
 * `credential` substitutes unconditionally, header on or off.
 * `network-identifier`/`tenant-identity` only when the header says on.
 * `public`, `arbitrary-text` and unclassified fields always pass through.
 *
 * A `credential` marked `conditionalCredential` is header-gated like
 * `network-identifier` but keeps the opaque placeholder, since a
 * plausible-looking fake key is still a key someone could try to use.
 */
function applySensitivity(
  sensitivity: Sensitivity | undefined,
  raw: unknown,
  ctx: MaskRuntimeContext,
  conditionalCredential = false,
  screenOnly = false,
): unknown {
  if (sensitivity === Sensitivity.CREDENTIAL && !conditionalCredential) {
    return substituteScalar(raw, () => CREDENTIAL_PLACEHOLDER);
  }
  if (!ctx.maskOn) return raw;
  if (screenOnly && !ctx.screenShare) return raw;
  if (sensitivity === Sensitivity.CREDENTIAL && conditionalCredential) {
    return substituteScalar(raw, () => CREDENTIAL_PLACEHOLDER);
  }
  if (
    sensitivity === Sensitivity.NETWORK_IDENTIFIER ||
    sensitivity === Sensitivity.TENANT_IDENTITY
  ) {
    return substituteScalar(raw, (real) =>
      fakeValueFor(sensitivity, real, ctx.session, ctx.saltSecret),
    );
  }
  return raw;
}

function maskValue(
  value: unknown,
  plan: ClassPlan,
  isArray: boolean,
  ctx: MaskRuntimeContext,
): unknown {
  if (value == null) return value;

  if (isArray) {
    return Array.isArray(value)
      ? value.map((el) => maskValue(el, plan, false, ctx))
      : value;
  }

  if (typeof value !== 'object' || value instanceof Date) return value;

  // A fresh object per node: the controller's response may be a cached or
  // shared reference, and substituting into it would leak the fake value to
  // the next unmasked reader of that same cache entry.
  const out: Record<string, unknown> = {
    ...(value as Record<string, unknown>),
  };
  for (const [key, field] of plan) {
    if (!(key in out)) continue;
    out[key] = field.nested
      ? maskValue(out[key], field.nested, field.isArray, ctx)
      : applySensitivity(
          field.sensitivity,
          out[key],
          ctx,
          field.conditionalCredential,
          field.screenOnly,
        );
  }
  return out;
}

function headerValue(req: MaskRequest, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * The global response-masking pass for mask mode.
 *
 * A route whose response type `resolveRouteResponseType` cannot resolve has
 * no declared fields to go by: while a person shares their screen it gets the
 * shape-and-name fallback of {@link maskUntyped}; an agent's tool result keeps
 * it as it is, since nothing says which of those values the agent must hand
 * back. Wrapping such a response in a real DTO is
 * still what classifies it properly, one surface at a time.
 */
@Injectable()
export class MaskResponseInterceptor implements NestInterceptor {
  constructor(
    private readonly registry: SensitivityRegistry,
    private readonly config: ConfigService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const resolved = resolveRouteResponseType(context.getHandler());

    const request = context.switchToHttp().getRequest<MaskRequest>();
    // Two independent reasons this response should be masked, either is enough:
    // the browser's own screen-share toggle, OR this call arrived over the
    // loopback socket a tool call makes (`agentSurfaceOf` is the same fail-closed,
    // token-verified check the action cycle uses — see actor-surface.ts's own
    // doc comment for why a bare header cannot be spoofed into claiming this).
    // Every tool result an MCP client or the in-product assistant receives goes
    // to a model, on every turn, regardless of whether a human currently has the
    // screen-share toggle on — unlike the browser's own default (off, tuned for
    // "am I about to share my screen"), there is no reason network-identifier/
    // tenant-identity data should ever reach that channel unmasked by default.
    const screenShare = headerValue(request, 'x-mask-mode') === 'on';
    const maskOn =
      screenShare ||
      agentSurfaceOf(request.headers as Record<string, unknown>) !== undefined;
    const ctx: MaskRuntimeContext = {
      maskOn,
      screenShare,
      // No stable session id reaches an unauthenticated route; one fixed
      // bucket keeps any masking that does apply internally consistent.
      session: {
        sub: request.user?.userId ?? 'anonymous',
        iat: request.user?.iat,
      },
      saltSecret: resolveMaskSaltSecret(this.config),
    };

    if (!resolved) {
      if (!screenShare) return next.handle();
      return next
        .handle()
        .pipe(map((body) => maskUntyped(body, ctx.session, ctx.saltSecret)));
    }
    const plan = planFor(resolved.type, this.registry);
    return next
      .handle()
      .pipe(map((body) => maskValue(body, plan, resolved.isArray, ctx)));
  }
}
