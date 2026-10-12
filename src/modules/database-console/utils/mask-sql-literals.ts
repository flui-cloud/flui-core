export const MASKED_QUERY_MAX = 1024;

const isIdentChar = (c: string | undefined): boolean =>
  !!c && /[\w$\u0080-￿]/.test(c);

const isDigit = (c: string | undefined): boolean => !!c && c >= '0' && c <= '9';

const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/;
const RADIX_NUMBER = /^0(?:[xX][\dA-Fa-f_]+|[oO][0-7_]+|[bB][01_]+)/;
const MANTISSA = /^(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)/;
const EXPONENT = /^[eE][+-]?\d+/;

/** What a token at `i` turns into, and where scanning resumes. */
type Token = { end: number; text: string };

/** Index just past a quoted string opened at `open`, or the end when it never closes. */
function endOfQuoted(sql: string, open: number, escapes: boolean): number {
  let i = open + 1;
  while (i < sql.length) {
    const c = sql[i];
    if (escapes && c === '\\') {
      i += 2;
    } else if (c === "'" && sql[i + 1] === "'") {
      i += 2;
    } else if (c === "'") {
      return i + 1;
    } else {
      i++;
    }
  }
  return sql.length;
}

function endOfBlockComment(sql: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < sql.length) {
    if (sql.startsWith('/*', i)) {
      depth++;
      i += 2;
    } else if (sql.startsWith('*/', i)) {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  return sql.length;
}

function endOfQuotedIdentifier(sql: string, open: number): number {
  let j = open + 1;
  while (j < sql.length) {
    if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
    else if (sql[j] === '"') return j + 1;
    else j++;
  }
  return sql.length;
}

function commentAt(sql: string, i: number): Token | null {
  if (sql.startsWith('--', i)) {
    const nl = sql.indexOf('\n', i);
    return { end: nl === -1 ? sql.length : nl, text: ' ' };
  }
  if (sql.startsWith('/*', i)) {
    return { end: endOfBlockComment(sql, i), text: ' ' };
  }
  return null;
}

function prefixedStringAt(sql: string, i: number): Token | null {
  const c = sql[i];
  const next = sql[i + 1];
  if (/[eE]/.test(c) && next === "'") {
    return { end: endOfQuoted(sql, i + 1, true), text: '?' };
  }
  if (/[bBxXnN]/.test(c) && next === "'") {
    return { end: endOfQuoted(sql, i + 1, false), text: '?' };
  }
  if (/[uU]/.test(c) && next === '&' && sql[i + 2] === "'") {
    return { end: endOfQuoted(sql, i + 2, false), text: '?' };
  }
  return null;
}

function dollarAt(sql: string, i: number): Token | null {
  if (sql[i] !== '$') return null;
  if (isDigit(sql[i + 1])) {
    let j = i + 1;
    while (isDigit(sql[j])) j++;
    return { end: j, text: sql.slice(i, j) };
  }
  const tag = DOLLAR_TAG.exec(sql.slice(i, i + 256))?.[0];
  if (!tag) return null;
  const close = sql.indexOf(tag, i + tag.length);
  return { end: close === -1 ? sql.length : close + tag.length, text: '?' };
}

function numberAt(sql: string, i: number): Token | null {
  if (!isDigit(sql[i]) && !(sql[i] === '.' && isDigit(sql[i + 1]))) {
    return null;
  }
  const rest = sql.slice(i, i + 128);
  const radix = RADIX_NUMBER.exec(rest)?.[0];
  if (radix) return { end: i + radix.length, text: '?' };
  const mantissa = MANTISSA.exec(rest)?.[0];
  if (!mantissa) return null;
  const exponent = EXPONENT.exec(rest.slice(mantissa.length))?.[0] ?? '';
  return { end: i + mantissa.length + exponent.length, text: '?' };
}

function tokenAt(sql: string, i: number): Token | null {
  const comment = commentAt(sql, i);
  if (comment) return comment;
  if (sql[i] === '"') {
    const end = endOfQuotedIdentifier(sql, i);
    return { end, text: sql.slice(i, end) };
  }
  if (sql[i] === "'") return { end: endOfQuoted(sql, i, false), text: '?' };
  if (isIdentChar(sql[i - 1])) return null;
  return prefixedStringAt(sql, i) ?? dollarAt(sql, i) ?? numberAt(sql, i);
}

/**
 * A statement's shape without its values: every string, dollar-quoted body,
 * bit/hex string and number becomes `?`, comments go, identifiers and keywords
 * stay. A literal the server cut short (`track_activity_query_size`) is masked
 * to the end, so a truncated `PASSWORD '...` never leaks its tail.
 */
export function maskSqlLiterals(
  sql: string | null | undefined,
  max = MASKED_QUERY_MAX,
): string {
  if (!sql) return '';
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const token = tokenAt(sql, i);
    if (token) {
      out += token.text;
      i = token.end;
    } else {
      out += sql[i];
      i++;
    }
  }
  const collapsed = out.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed;
}
