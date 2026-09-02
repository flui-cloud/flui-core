import { Injectable } from '@nestjs/common';
import { Sensitivity } from './constants/sensitivity';
import {
  SENSITIVITY_CONDITIONAL_KEY,
  SENSITIVITY_FIELDS_KEY,
  SENSITIVITY_METADATA_KEY,
} from './decorators/sensitivity.decorator';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DtoClass = new (...args: any[]) => object;

/**
 * The one place the field-level `@Sensitivity` metadata is read back from, at
 * request time. `sensitivity-sentinel.spec.ts` deliberately does not use it:
 * it reads `*.dto.ts` source syntactically instead, so a decorator typo or a
 * class that fails to import is still caught. This is the runtime twin of that
 * static check, not a replacement for it.
 */
@Injectable()
export class SensitivityRegistry {
  private readonly cache = new Map<
    DtoClass,
    ReadonlyMap<string, Sensitivity>
  >();

  /** Field name → declared Sensitivity, for this class's own decorated properties. */
  getSensitivities(dtoClass: DtoClass): ReadonlyMap<string, Sensitivity> {
    const cached = this.cache.get(dtoClass);
    if (cached) return cached;

    const keys: (string | symbol)[] =
      Reflect.getMetadata(SENSITIVITY_FIELDS_KEY, dtoClass.prototype) ?? [];
    const map = new Map<string, Sensitivity>();
    for (const key of keys) {
      const level = Reflect.getMetadata(
        SENSITIVITY_METADATA_KEY,
        dtoClass.prototype,
        key,
      ) as Sensitivity | undefined;
      if (level) map.set(String(key), level);
    }
    this.cache.set(dtoClass, map);
    return map;
  }

  sensitivityOf(dtoClass: DtoClass, field: string): Sensitivity | undefined {
    return this.getSensitivities(dtoClass).get(field);
  }

  /** True only for a `CREDENTIAL` field explicitly marked `{ conditional: true }`. */
  isConditionalCredential(dtoClass: DtoClass, field: string): boolean {
    return (
      Reflect.getMetadata(
        SENSITIVITY_CONDITIONAL_KEY,
        dtoClass.prototype,
        field,
      ) === true
    );
  }
}
