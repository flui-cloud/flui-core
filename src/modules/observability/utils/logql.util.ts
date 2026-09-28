import { BadRequestException } from '@nestjs/common';

/**
 * A caller's value as a LogQL double-quoted string literal. Escaping keeps it
 * inside the quotes, so it can never close a selector or append a stage; a
 * regex keeps its meaning because the literal is unescaped before compiling.
 */
export function logqlString(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new BadRequestException('Log filters cannot contain line breaks');
  }
  const escaped = value
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('"', String.raw`\"`);
  return `"${escaped}"`;
}

export function logqlCaseInsensitive(pattern: string): string {
  return logqlString(`(?i)${pattern}`);
}

export function logqlDuration(value: string): string {
  if (!/^\d{1,6}(ms|s|m|h|d|w|y)$/.test(value)) {
    throw new BadRequestException(
      'step must be a duration such as 30s, 5m or 1h',
    );
  }
  return value;
}
