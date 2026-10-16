import { SAFE_NAME } from '../utils/manifest-render.util';

export const MANIFEST_DIR = '/var/lib/rancher/k3s/server/manifests';

export interface HeldFile {
  sha: string;
  carriesSecret: boolean;
  /**
   * Only the digest came back because a template of this file names a secret
   * variable, so the rendered copy may hold its value.
   */
  withheld?: boolean;
  /** For a withheld file: every resource in it carries the owner label. */
  declaresProvenance?: boolean;
  /** Absent for a file carrying a Secret or withheld: it never leaves the master. */
  content?: string;
  /** The image references the file declares; never read from a Secret. */
  images?: string[];
}

const IMAGE_REF = /^[A-Za-z0-9._/:@-]+$/;
const QUOTED_REF = /^(["']?)([^"']*)\1$/;
const IMAGE_LINE = `^[[:space:]]+image:[[:space:]]*["']?[A-Za-z0-9._/:@-]+["']?[[:space:]]*$`;
const ESCAPED_QUOTE = String.raw`'\''`;
const shellQuoted = (text: string) =>
  `'${text.replaceAll("'", ESCAPED_QUOTE)}'`;

/**
 * Files that rendered a secret value into their body in releases published
 * before `manifests/SECRETS` existed. Always withheld: a master can still hold
 * such a copy long after the release that wrote it is forgotten.
 */
export const WITHHELD_BY_HISTORY: readonly string[] = [
  '02-postgres.yaml',
  '03-redis.yaml',
  '04d-alertmanager.yaml',
  '08-grafana.yaml',
  '09-flui-api.yaml',
];

/**
 * The read job's script. The body of a file carrying a Secret, or named in
 * `withhold`, is never printed — pod logs are the channel it would travel on.
 */
export function readScript(
  withhold: Iterable<string> | 'all',
  dir: string = MANIFEST_DIR,
): string {
  const names =
    withhold === 'all'
      ? []
      : [...new Set([...withhold, ...WITHHELD_BY_HISTORY])].filter((n) =>
          SAFE_NAME.test(n),
        );
  return [
    'set -e',
    `cd ${dir} 2>/dev/null || { echo "NODIR"; exit 0; }`,
    `ALL=${withhold === 'all' ? 1 : 0}`,
    `WITHHOLD=" ${names.join(' ')} "`,
    'held_back() {',
    '  [ "$ALL" = 1 ] && return 0',
    '  case "$WITHHOLD" in *" $1 "*) return 0;; esac',
    '  return 1',
    '}',
    'for f in *.yaml; do',
    '  [ -e "$f" ] || continue',
    '  sha=$(sha256sum "$f" | cut -d" " -f1)',
    '  if grep -qE "^kind:[[:space:]]*Secret" "$f"; then',
    '    echo "FILE $f $sha secret"',
    '    continue',
    '  elif held_back "$f"; then',
    '    kinds=$(grep -cE "^kind:" "$f" || true)',
    '    owners=$(grep -cE "^[[:space:]]+flui.cloud/owner-kind:" "$f" || true)',
    '    echo "FILE $f $sha withheld $kinds $owners"',
    '  else',
    '    echo "FILE $f $sha plain"',
    '    echo "BODY $(base64 -w0 < "$f")"',
    '  fi',
    `  grep -E ${shellQuoted(IMAGE_LINE)} "$f" | sed -E 's/^[[:space:]]+image:[[:space:]]*//; s/[[:space:]]+$//' | while IFS= read -r ref; do`,
    '    echo "IMAGE $f $ref"',
    '  done',
    'done',
  ].join('\n');
}

function fileEntry(
  sha: string,
  kind: string,
  kinds: string,
  owners: string,
): HeldFile {
  const entry: HeldFile = { sha, carriesSecret: kind === 'secret' };
  if (kind === 'withheld') {
    const resources = Number(kinds);
    entry.withheld = true;
    entry.declaresProvenance = resources > 0 && Number(owners) >= resources;
  }
  return entry;
}

function imageRef(entry: HeldFile | undefined, quoted: string, extra?: string) {
  if (!entry || entry.carriesSecret || extra !== undefined) return undefined;
  const ref = QUOTED_REF.exec(quoted ?? '')?.[2];
  return ref && IMAGE_REF.test(ref) ? ref : undefined;
}

function addImage(held: Map<string, HeldFile>, line: string): void {
  const [, name, quoted, extra] = line.trim().split(/\s+/);
  const entry = held.get(name);
  const ref = imageRef(entry, quoted, extra);
  if (entry && ref) entry.images = [...(entry.images ?? []), ref];
}

export function parseReadLogs(logs: string): Map<string, HeldFile> {
  const held = new Map<string, HeldFile>();
  let last: string | null = null;
  for (const line of logs.split('\n')) {
    if (line.startsWith('FILE ')) {
      const [, name, sha, kind, kinds, owners] = line.trim().split(/\s+/);
      held.set(name, fileEntry(sha, kind, kinds, owners));
      last = kind === 'plain' ? name : null;
    } else if (line.startsWith('IMAGE ')) {
      addImage(held, line);
    } else if (line.startsWith('BODY ') && last) {
      const entry = held.get(last);
      if (entry) entry.content = decodeBody(line);
      last = null;
    }
  }
  return held;
}

function decodeBody(line: string): string {
  return Buffer.from(line.slice(5).trim(), 'base64').toString('utf8');
}
