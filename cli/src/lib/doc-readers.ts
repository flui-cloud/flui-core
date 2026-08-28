/**
 * Reading fields out of a document a person wrote by hand.
 *
 * Every reader takes the same `problems` array rather than throwing, because a
 * file is fixed in an editor: the reader that finds the third mistake has to
 * still be running when the first one was found.
 */

export function readStringList(
  input: unknown,
  field: string,
  problems: string[],
): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    problems.push(`\`${field}\` must be a list, got ${describeType(input)}`);
    return [];
  }
  const out: string[] = [];
  input.forEach((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      problems.push(
        `\`${field}[${index}]\` must be a non-empty name, got ${describeType(entry)}`,
      );
      return;
    }
    out.push(entry.trim());
  });
  return out;
}

export function readEnum<T extends string>(
  input: unknown,
  field: string,
  allowed: readonly T[],
  fallback: T,
  problems: string[],
): T {
  if (input === undefined || input === null) return fallback;
  if (typeof input !== 'string' || !allowed.includes(input as T)) {
    problems.push(
      `\`${field}\` must be one of ${allowed.join(', ')}, got ${describeType(input)}`,
    );
    return fallback;
  }
  return input as T;
}

export function readInt(
  input: unknown,
  field: string,
  minimum: number,
  problems: string[],
): number | null {
  if (typeof input !== 'number' || !Number.isInteger(input)) {
    problems.push(
      input === undefined
        ? `missing \`${field}\``
        : `\`${field}\` must be a whole number, got ${describeType(input)}`,
    );
    return null;
  }
  if (input < minimum) {
    problems.push(`\`${field}\` must be ${minimum} or more, got ${input}`);
    return null;
  }
  return input;
}

export function requiredString(
  input: unknown,
  field: string,
  problems: string[],
): string {
  if (typeof input !== 'string' || !input.trim()) {
    problems.push(
      input === undefined
        ? `missing \`${field}\``
        : `\`${field}\` must be a non-empty name, got ${describeType(input)}`,
    );
    return '';
  }
  return input.trim();
}

/** Like {@link requiredString}, but tolerant of `cpu: 2` written unquoted. */
export function requiredScalarString(
  input: unknown,
  field: string,
  problems: string[],
): string {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return String(input);
  }
  return requiredString(input, field, problems);
}

export function asRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

export function describeType(input: unknown): string {
  if (input === undefined) return 'nothing';
  if (input === null) return 'null';
  if (Array.isArray(input)) return 'a list';
  if (typeof input === 'object') return 'a block';
  return JSON.stringify(input);
}
