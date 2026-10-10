/**
 * A value as a PromQL double-quoted string literal's content. Every label value
 * that comes from a request or a record goes through here: a quote or a
 * newline in it would otherwise close the matcher and widen the query.
 */
export function promString(value: string | null | undefined): string {
  return String(value ?? '')
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('"', String.raw`\"`)
    .replaceAll('\n', String.raw`\n`)
    .replaceAll('\r', String.raw`\r`);
}

/** A value matched literally inside a `=~` regex matcher. */
export function promRegexLiteral(value: string | null | undefined): string {
  return promString(
    String(value ?? '').replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`),
  );
}
