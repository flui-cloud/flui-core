import { DtoClass } from '../sensitivity.registry';

/**
 * `@nestjs/swagger`'s own metadata keys, pinned as literals because the
 * package does not re-export them from its public entrypoint.
 *
 * Reading them is how `MaskResponseInterceptor` learns which DTO class governs
 * a response without `instanceof`: controllers here return plain object
 * literals shaped like their declared DTO, so the `@ApiResponse` decorator
 * already on the route is the only place the response type is recorded.
 */
const SWAGGER_API_RESPONSE = 'swagger/apiResponse';
const SWAGGER_MODEL_PROPERTIES = 'swagger/apiModelProperties';
const SWAGGER_MODEL_PROPERTIES_ARRAY = 'swagger/apiModelPropertiesArray';

interface SwaggerResponseEntry {
  type?: unknown;
  isArray?: boolean;
}

interface SwaggerPropertyMeta {
  type?: unknown;
  isArray?: boolean;
}

/**
 * `type: () => X`, which DTOs here use to dodge circular imports.
 * `@nestjs/swagger` distinguishes it from a direct class reference by name
 * alone — `type.name === 'type'`, true only because it was written as the
 * `type:` property of an options object literal — so this mirrors that check
 * rather than inventing a different one.
 */
function isLazyTypeFunc(type: unknown): type is () => unknown {
  return (
    typeof type === 'function' && (type as { name?: string }).name === 'type'
  );
}

/** Mirrors `getTypeIsArrayTuple` in `@nestjs/swagger`'s own decorator helpers. */
function typeIsArrayTuple(
  input: unknown,
  isArrayFlag: boolean,
): [unknown, boolean] {
  if (!input) return [input, isArrayFlag];
  if (isArrayFlag) return [input, isArrayFlag];
  const isInputArray = Array.isArray(input);
  return [isInputArray ? (input as unknown[])[0] : input, isInputArray];
}

function normalizeType(
  rawType: unknown,
  rawIsArray: boolean | undefined,
): [unknown, boolean] {
  let type = rawType;
  const isArray = !!rawIsArray;
  if (isLazyTypeFunc(type)) {
    type = type();
  }
  return typeIsArrayTuple(type, isArray);
}

/** A DTO class, for our purposes: a function whose prototype ever carried `@ApiProperty`. */
export function isDtoClass(type: unknown): type is DtoClass {
  return (
    typeof type === 'function' &&
    !!(type as { prototype?: unknown }).prototype &&
    Reflect.getMetadata(
      SWAGGER_MODEL_PROPERTIES_ARRAY,
      (type as DtoClass).prototype,
    ) !== undefined
  );
}

/**
 * Which route-response DTO class (and whether it's an array of them) governs
 * this handler, if any. Takes `object` rather than `Function` — the metadata
 * is read by reference identity only, and NestJS's own `ExecutionContext`
 * types `getHandler()` as the broad, lint-discouraged `Function`.
 */
export function resolveRouteResponseType(
  handler: object,
): { type: DtoClass; isArray: boolean } | undefined {
  const responses = Reflect.getMetadata(SWAGGER_API_RESPONSE, handler) as
    | Record<string, SwaggerResponseEntry>
    | undefined;
  if (!responses) return undefined;

  for (const status of Object.keys(responses)) {
    const code = Number(status);
    if (!Number.isFinite(code) || code < 200 || code >= 300) continue;
    const [type, isArray] = normalizeType(
      responses[status].type,
      responses[status].isArray,
    );
    if (isDtoClass(type)) return { type, isArray };
  }
  return undefined;
}

/** The `@ApiProperty`-decorated property names of a DTO class. */
export function dtoPropertyKeys(dtoClass: DtoClass): string[] {
  const keys =
    (Reflect.getMetadata(SWAGGER_MODEL_PROPERTIES_ARRAY, dtoClass.prototype) as
      | string[]
      | undefined) ?? [];
  return keys.map((key) => key.replace(/^:/, ''));
}

/** One property's declared type, with lazy `type: () => X` and array forms resolved. */
export function dtoPropertyType(
  dtoClass: DtoClass,
  key: string,
): [unknown, boolean] {
  const meta = Reflect.getMetadata(
    SWAGGER_MODEL_PROPERTIES,
    dtoClass.prototype,
    key,
  ) as SwaggerPropertyMeta | undefined;
  return normalizeType(meta?.type, meta?.isArray);
}
