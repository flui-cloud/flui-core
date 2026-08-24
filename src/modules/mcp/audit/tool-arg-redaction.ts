import type { ZodRawShape } from 'zod';

/**
 * The same marker the product already shows a person for a value they may not
 * read (`variables.controller.ts` masks every sensitive key as this). Reusing
 * it means the audit and the variables view say "withheld" in one vocabulary.
 */
export const REDACTED = '****';

/** Objects nest; a schema that somehow recurses must not take the logger with it. */
const MAX_DEPTH = 6;

/** Beyond this an array is summarised rather than listed, whatever it holds. */
const MAX_ARRAY = 20;

/**
 * The arguments of a tool call, in a form that cannot carry a secret.
 *
 * **The invariant, and the only thing worth remembering about this file: every
 * value that comes out of here verbatim is a member of a set written in Flui's
 * own source.** An enum's cases, a literal, a boolean, a number. Everything
 * else — every string, every record, every array of strings, every argument
 * whose schema this walker does not recognise — comes out as {@link REDACTED}.
 *
 * It is a property of the *shape*, not of the field name, and that is the whole
 * point. A list of "sensitive-looking argument names" is a list somebody has to
 * remember to extend the day a tool is added, and the day they forget is the
 * day a password is written to the database in clear. `catalog_install` alone
 * takes `userInputs` and `envOverrides`, both `z.record(z.string(),
 * z.string())`, and both are exactly where an admin password lands; `app_deploy_spec`
 * takes a whole manifest as one string. None of them is named like a secret.
 *
 * Two rejected alternatives, because they were nearly taken:
 *
 *  - **let identifiers through when they look like a UUID.** It would have kept
 *    "which application" in the log, which is what a review screen actually
 *    wants. It is false here and measurably so: `local-auth.service.ts` mints a
 *    refresh token as a bare `crypto.randomUUID()`, and
 *    `application-workflow.service.ts` mints a webhook token as a bare
 *    `uuidv4()`. A UUID in this product is not proof of "not a credential", so
 *    the shape cannot be an exemption. Which application a call touched is
 *    recovered instead by joining `operation_id` to the operations table, whose
 *    resource fields the server wrote itself;
 *  - **hash the free-form values.** Non-reversible in principle, brute-forceable
 *    in practice for anything a person chose, and useless on a screen. A digest
 *    of a password is not a redaction, it is a slower disclosure.
 *
 * Fail-closed at every branch: no schema, no record; an unrecognised Zod node,
 * a value that does not actually match its declared closed set, a key the
 * schema never declared — all withheld. The safe direction is losing detail.
 */
export function redactToolArgs(
  shape: ZodRawShape | undefined,
  args: unknown,
): Record<string, unknown> | null {
  if (!shape || !isPlainObject(args)) return null;
  return redactShape(shape, args, 0);
}

interface ZodDefLike {
  type?: string;
  innerType?: unknown;
  out?: unknown;
  entries?: Record<string, unknown>;
  values?: unknown[];
  shape?: ZodRawShape;
  element?: unknown;
}

function defOf(schema: unknown): ZodDefLike | undefined {
  return (schema as { _zod?: { def?: ZodDefLike } } | undefined)?._zod?.def;
}

/**
 * Wrappers that change whether a value may be absent, not what it may be.
 *
 * `pipe` is here because of `coerceBoolean()` / `coerceNumber()`: an LLM sends
 * `"true"` and `z.preprocess` puts the real schema in `out`. Unwrapping to it
 * reads the constraint the argument is finally held to.
 */
function unwrap(schema: unknown, depth = 0): ZodDefLike | undefined {
  const def = defOf(schema);
  if (!def || depth > MAX_DEPTH) return def;
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'readonly':
    case 'catch':
      return unwrap(def.innerType, depth + 1);
    case 'pipe':
      return unwrap(def.out, depth + 1);
    default:
      return def;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function redactShape(
  shape: ZodRawShape,
  value: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Driven by the SCHEMA's keys, never the value's: a key the schema does not
  // declare is model-supplied text, and a key name can be a secret as easily as
  // a value can (`{"sk_live_…": true}`). Undeclared keys are dropped whole.
  for (const key of Object.keys(shape)) {
    if (!(key in value)) continue;
    if (value[key] === undefined) continue;
    out[key] = redactValue(shape[key], value[key], depth + 1);
  }
  return out;
}

function redactValue(schema: unknown, value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  // A null carries nothing; keeping it distinguishes "passed as null" from
  // "withheld", which is the one distinction free of risk.
  if (value === null) return null;

  const def = unwrap(schema);
  switch (def?.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : REDACTED;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? value
        : REDACTED;
    case 'enum':
      // Re-checked against the declared cases rather than trusted: on the
      // assistant surface these are the model's raw arguments, and a value that
      // is not one of the cases has no business being echoed just because it
      // sat in a field typed as an enum.
      return Object.values(def.entries ?? {}).includes(value)
        ? value
        : REDACTED;
    case 'literal':
      return (def.values ?? []).includes(value) ? value : REDACTED;
    case 'object':
      return def.shape && isPlainObject(value)
        ? redactShape(def.shape, value, depth)
        : REDACTED;
    case 'array':
      return redactArray(def.element, value, depth);
    default:
      return REDACTED;
  }
}

/**
 * An array survives only when every element does, so a mixed array cannot leak
 * one string among the enum cases that hid it.
 */
function redactArray(element: unknown, value: unknown, depth: number): unknown {
  if (!Array.isArray(value) || value.length > MAX_ARRAY) return REDACTED;
  const mapped = value.map((item) => redactValue(element, item, depth + 1));
  return mapped.includes(REDACTED) ? REDACTED : mapped;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The handle of the async operation a tool call started, when it started one.
 *
 * This is the join that gives the argument redaction back its usefulness
 * without giving it back its risk. The log cannot say *which* application was
 * deleted, because that id arrived as model-supplied text; the operations row
 * can, because Flui wrote `resourceName`, `resourceId` and `operationType` into
 * it itself. One uuid links them.
 *
 * Read narrowly on purpose — a single top-level field, of a single name, that
 * must parse as a uuid — so nothing else from the tool's result is ever
 * recorded. A result has no declared schema, so the invariant above cannot be
 * extended to it, and what cannot be bounded is not written.
 */
export function startedOperationId(data: unknown): string | null {
  if (!isPlainObject(data)) return null;
  const id = data.operationId;
  return typeof id === 'string' && UUID.test(id) ? id : null;
}
