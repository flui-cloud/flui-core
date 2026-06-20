import { BadRequestException } from '@nestjs/common';

// shell-bson-parser turns object/array literals + BSON ctors (ObjectId(), ISODate(),
// NumberDecimal(), …) into REAL BSON values; the caller serializes the built command
// to Extended JSON before it crosses the gate, which decodes it back to BSON.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parse: parseBson } = require('@mongodb-js/shell-bson-parser') as {
  parse: (input: string, opts: { mode: string }) => unknown;
};

export interface Segment {
  name: string;
  call: boolean;
  /** Raw text inside the call's parentheses (empty for property access / `()`). */
  args: string;
}

export function bad(message: string): BadRequestException {
  return new BadRequestException(message);
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}

/** Parse a comma-separated argument list (mongosh literals) into JS/BSON values. */
export function parseArgs(raw: string): unknown[] {
  const t = raw.trim();
  if (!t) return [];
  try {
    const arr = parseBson(`[${t}]`, { mode: 'loose' });
    if (!Array.isArray(arr)) throw new Error('expected an argument list');
    return arr;
  } catch (err) {
    throw bad(`Invalid arguments: ${errText(err)}`);
  }
}

export function asObject(v: unknown, label: string): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  throw bad(`${label} expects an object, e.g. { field: value }`);
}

export function asArray(v: unknown, label: string): unknown[] {
  if (Array.isArray(v)) return v;
  throw bad(`${label} expects an array, e.g. [ { … }, { … } ]`);
}

// Advance past a quoted run (a backslash escapes the next char); returns the index
// of the closing quote, or the last index if the quote never closes.
function skipQuoted(s: string, openAt: number): number {
  const quote = s[openAt];
  for (let i = openAt + 1; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === quote) return i;
  }
  return s.length - 1;
}

/** Read a balanced (…)/[…] block; tolerant of quoted strings so a `)` in a string is safe. */
function readBalanced(
  s: string,
  start: number,
  open: string,
  close: string,
): { inner: string; end: number } {
  let depth = 0;
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipQuoted(s, i) + 1;
      continue;
    }
    if (c === open) {
      depth++;
    } else if (c === close) {
      depth--;
      if (depth === 0) return { inner: s.slice(start + 1, i), end: i };
    }
    i++;
  }
  throw bad(`Unbalanced "${open}${close}" in shell expression`);
}

// Parse a `.name` or `.name(args)` segment starting at the dot; returns the segment
// and the index just past it.
function parseDotSegment(
  expr: string,
  dotAt: number,
): { seg: Segment; end: number } {
  let i = dotAt + 1;
  const m = /^[A-Za-z_$][\w$]*/.exec(expr.slice(i));
  if (!m) throw bad('Expected a name after "." in the shell expression');
  const name = m[0];
  i += name.length;
  while (expr[i] === ' ') i++;
  if (expr[i] === '(') {
    const { inner, end } = readBalanced(expr, i, '(', ')');
    return { seg: { name, call: true, args: inner }, end: end + 1 };
  }
  return { seg: { name, call: false, args: '' }, end: i };
}

/** Tokenize the chain after `db` into property/call segments (db.users.find({}).limit(1)). */
export function parseDbChain(expr: string): Segment[] {
  const segs: Segment[] = [];
  let i = 2; // past the leading "db"
  while (i < expr.length) {
    const c = expr[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '.') {
      const { seg, end } = parseDotSegment(expr, i);
      segs.push(seg);
      i = end;
    } else if (c === '[') {
      const { inner, end } = readBalanced(expr, i, '[', ']');
      const key = parseBson(inner, { mode: 'loose' });
      if (typeof key !== 'string') {
        throw bad(
          'Only string index access is supported, e.g. db["my-collection"]',
        );
      }
      segs.push({ name: key, call: false, args: '' });
      i = end + 1;
    } else {
      throw bad(`Unexpected character "${c}" in shell expression`);
    }
  }
  return segs;
}
