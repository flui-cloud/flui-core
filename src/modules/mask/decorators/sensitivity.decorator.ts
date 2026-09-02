import { Sensitivity as SensitivityLevel } from '../constants/sensitivity';

/** Where the metadata lives: DTO class prototype + property key → {@link SensitivityLevel}. */
export const SENSITIVITY_METADATA_KEY = 'mask:sensitivity';

/**
 * The list of property keys ever classified on a given prototype. Per-property
 * metadata cannot be enumerated back, so the decorator appends to this
 * companion array on every application — the same shape `@ApiProperty` uses
 * for its own `API_MODEL_PROPERTIES_ARRAY`.
 */
export const SENSITIVITY_FIELDS_KEY = 'mask:sensitivityFields';

/**
 * Companion flag, `CREDENTIAL` fields only: set when a field is a one-time
 * reveal at creation (a freshly minted API key) rather than a re-read of
 * something already stored. `CREDENTIAL` masks unconditionally, which for a
 * one-time reveal means nobody could ever see the value at all, so
 * `{ conditional: true }` gates that field on the header like
 * `NETWORK_IDENTIFIER`/`TENANT_IDENTITY` while keeping the opaque placeholder.
 */
export const SENSITIVITY_CONDITIONAL_KEY = 'mask:sensitivityConditional';

interface SensitivityOptions {
  conditional?: boolean;
}

function decorate(level: SensitivityLevel, options?: SensitivityOptions) {
  return (target: object, propertyKey: string | symbol): void => {
    const known: (string | symbol)[] =
      Reflect.getMetadata(SENSITIVITY_FIELDS_KEY, target) ?? [];
    if (!known.includes(propertyKey)) {
      Reflect.defineMetadata(
        SENSITIVITY_FIELDS_KEY,
        [...known, propertyKey],
        target,
      );
    }
    Reflect.defineMetadata(
      SENSITIVITY_METADATA_KEY,
      level,
      target,
      propertyKey,
    );
    if (options?.conditional) {
      Reflect.defineMetadata(
        SENSITIVITY_CONDITIONAL_KEY,
        true,
        target,
        propertyKey,
      );
    }
  };
}

/**
 * Classifies one response-DTO field for mask mode, next to its `@ApiProperty`.
 * Read by `SensitivityRegistry` at request time and by
 * `sensitivity-sentinel.spec.ts` at build time.
 *
 * Exported as one merged symbol — callable as the decorator, and carrying the
 * enum's own members — so a DTO imports `Sensitivity` once and writes
 * `@Sensitivity(Sensitivity.NETWORK_IDENTIFIER)` without aliasing the enum.
 */
export const Sensitivity: typeof decorate & typeof SensitivityLevel =
  Object.assign(decorate, SensitivityLevel);
