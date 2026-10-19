/**
 * Deterministic MDX → Markdown cleaning for the assistant knowledge base.
 *
 * The docs are Starlight MDX: imports, `<Tabs>/<TabItem>` variants of the same
 * step, screenshots and diagram components. The assistant needs the prose, the
 * tab labels (Dashboard / CLI / Agent) and the captions, not the markup. Fenced
 * code and inline code are never touched, so `<KEY>` placeholders survive.
 * Anything this cleaner does not know stays in place and `leftoverComponents`
 * reports it, so a new component fails the build instead of leaking markup.
 */

const WRAPPERS = new Set(['Tabs', 'Steps', 'CardGrid']);
const LABELLED = new Set(['TabItem', 'Card', 'Aside']);
const TEXT_ATTRS = ['caption', 'alt', 'title', 'description'];

interface Segment {
  code: boolean;
  text: string;
}

function splitFences(src: string): Segment[] {
  const segments: Segment[] = [];
  const lines = src.split('\n');
  let buffer: string[] = [];
  let fence: string | null = null;
  const flush = (code: boolean): void => {
    if (buffer.length) segments.push({ code, text: buffer.join('\n') });
    buffer = [];
  };
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null && marker) {
      flush(false);
      fence = marker;
      buffer.push(line);
    } else if (
      fence !== null &&
      marker &&
      marker[0] === fence[0] &&
      marker.length >= fence.length &&
      /^\s*[`~]+\s*$/.test(line)
    ) {
      buffer.push(line);
      flush(true);
      fence = null;
    } else {
      buffer.push(line);
    }
  }
  flush(fence !== null);
  return segments.map((s, i) =>
    i < segments.length - 1 ? { ...s, text: s.text + '\n' } : s,
  );
}

function joinSegments(segments: Segment[]): string {
  return segments.map((s) => s.text).join('');
}

const INLINE_CODE = /(`+)[^`\n]*?\1/g;

function maskInlineCode(text: string): { masked: string; spans: string[] } {
  const spans: string[] = [];
  const masked = text.replace(INLINE_CODE, (m) => {
    spans.push(m);
    return `\u0000${spans.length - 1}\u0000`;
  });
  return { masked, spans };
}

function unmask(text: string, spans: string[]): string {
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]);
}

export function stripHtmlComments(src: string): string {
  return joinSegments(
    splitFences(src).map((s) =>
      s.code ? s : { ...s, text: s.text.replace(/<!--[\s\S]*?-->/g, '') },
    ),
  );
}

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: Record<string, string>;
  end: number;
}

function parseTag(text: string, start: number): Tag | null {
  const head = /^<(\/?)([A-Z][A-Za-z0-9]*)/.exec(text.slice(start));
  if (!head) return null;
  let i = start + head[0].length;
  let depth = 0;
  let quote: string | null = null;
  let topLevel = '';
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (depth === 0) topLevel += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      if (depth === 0) topLevel += c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && c === '>') {
      const selfClosing = text[i - 1] === '/';
      const attrs: Record<string, string> = {};
      for (const m of topLevel.matchAll(
        /([A-Za-z][\w-]*)=(?:"([^"]*)"|'([^']*)')/g,
      )) {
        attrs[m[1]] = m[2] ?? m[3];
      }
      return {
        name: head[2],
        closing: head[1] === '/',
        selfClosing,
        attrs,
        end: i + 1,
      };
    }
    if (depth === 0) topLevel += c;
  }
  return null;
}

function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return /[.!?:]$/.test(t) ? t : `${t}.`;
}

function replacementFor(tag: Tag): string | null {
  if (tag.closing) {
    return WRAPPERS.has(tag.name) ||
      LABELLED.has(tag.name) ||
      tag.name === 'LinkCard'
      ? ''
      : null;
  }
  if (tag.name === 'LinkCard') {
    const { title, description } = tag.attrs;
    if (!title) return '';
    return description
      ? `**${title}**: ${sentence(description)}`
      : `**${title}**`;
  }
  if (WRAPPERS.has(tag.name)) return '';
  if (LABELLED.has(tag.name)) {
    const label = tag.attrs.label ?? tag.attrs.title ?? tag.attrs.type;
    if (!label) return '';
    const shown =
      tag.name === 'Aside' && !tag.attrs.title
        ? label.charAt(0).toUpperCase() + label.slice(1)
        : label;
    return `**${shown}:**`;
  }
  if (tag.selfClosing) {
    const text = TEXT_ATTRS.map((a) => tag.attrs[a]).find((v) => v?.trim());
    if (!text) return '';
    const kind = tag.name === 'Screenshot' ? 'Screenshot' : 'Diagram';
    return `_${kind}: ${sentence(text)}_`;
  }
  return null;
}

function cleanProse(text: string): string {
  const withoutImports = text.replace(
    /^import\s+(?:[^\n]*?\sfrom\s+)?['"][^'"\n]+['"];?[ \t]*\n?/gm,
    '',
  );
  const { masked, spans } = maskInlineCode(
    withoutImports.replace(/<!--[\s\S]*?-->/g, ''),
  );
  let out = '';
  let i = 0;
  while (i < masked.length) {
    const at = masked.indexOf('<', i);
    if (at === -1) {
      out += masked.slice(i);
      break;
    }
    out += masked.slice(i, at);
    const tag = parseTag(masked, at);
    const replacement = tag ? replacementFor(tag) : null;
    if (tag && replacement !== null) {
      out += replacement;
      i = tag.end;
    } else {
      out += '<';
      i = at + 1;
    }
  }
  return unmask(out, spans);
}

export function cleanMdx(body: string): string {
  const cleaned = joinSegments(
    splitFences(body).map((s) =>
      s.code ? s : { ...s, text: cleanProse(s.text) },
    ),
  );
  return cleaned
    .split('\n')
    .map((l) => (l.trim() === '' ? '' : l.replace(/[ \t]+$/, '')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Component tags left in prose after cleaning (code and inline code excluded). */
export function leftoverComponents(cleaned: string): string[] {
  const found: string[] = [];
  for (const s of splitFences(cleaned)) {
    if (s.code) continue;
    const { masked } = maskInlineCode(s.text);
    for (const m of masked.matchAll(/<\/?[A-Z][A-Za-z0-9]*(?=[\s/>])/g)) {
      found.push(m[0]);
    }
  }
  return found;
}
