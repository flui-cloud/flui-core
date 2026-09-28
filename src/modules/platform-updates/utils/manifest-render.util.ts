import { createHash } from 'node:crypto';

export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.yaml$/;

const byBytes = (a: string, b: string): number => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

/**
 * A placeholder is `${NAME}`; a bare `$NAME` is somebody else's.
 *
 * The same rule the installer renders by, and it has to stay the same: this
 * decides whether a file needs values and that decides which names get them.
 * A bare `$NAME`, as in `{{ $labels.namespace }}`, is not a placeholder.
 */
export function placeholdersIn(text: string): string[] {
  const found = new Set<string>();
  for (const [, name] of text.matchAll(/\$\{([A-Za-z_]\w*)\}/g)) {
    found.add(name);
  }
  return [...found].sort(byBytes);
}

/**
 * What the installer did to a file besides substituting values, as it recorded
 * it in `kube-system/flui-install-values` (`transforms.json`).
 */
export interface InstallTransforms {
  /** Copied into the manifest directory as downloaded, never rendered. */
  raw?: string[];
  /** IngressRoutes whose empty `tls: {}` was bound to the system certificate. */
  ingressTls?: { secretName: string; files: string[] };
}

/**
 * `envsubst "$vars"` where `$vars` is the file's own `${NAME}` list — the
 * installer's `render_manifest`, byte for byte.
 *
 * With a variable list, envsubst replaces both `${NAME}` and a bare `$NAME` for
 * each listed name, and an unset one becomes the empty string. Anything not
 * listed is left exactly as written, which is what keeps `{{ $labels.x }}`.
 */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, string | undefined>>,
): string {
  const declared = new Set(placeholdersIn(template));
  if (declared.size === 0) return template;
  return template.replace(
    /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g,
    (whole: string, braced?: string, bare?: string) => {
      const name = braced ?? bare ?? '';
      return declared.has(name) ? (values[name] ?? '') : whole;
    },
  );
}

/** The installer's `sed 's|^  tls: {}$|  tls:\n    secretName: …|'`. */
export function bindIngressTls(content: string, secretName: string): string {
  return content
    .split('\n')
    .map((line) =>
      line === '  tls: {}' ? `  tls:\n    secretName: ${secretName}` : line,
    )
    .join('\n');
}

/** The file as the installer would have written it into the manifest directory. */
export function renderManifestFile(
  name: string,
  template: string,
  values: Readonly<Record<string, string | undefined>>,
  transforms: InstallTransforms = {},
): string {
  if (transforms.raw?.includes(name)) return template;
  const rendered = renderTemplate(template, values);
  const tls = transforms.ingressTls;
  return tls?.files.includes(name)
    ? bindIngressTls(rendered, tls.secretName)
    : rendered;
}

/** One value for the values a plan renders with; order-independent. */
export function valuesDigest(
  values: Readonly<Record<string, string | undefined>>,
): string {
  const lines = Object.keys(values)
    .sort(byBytes)
    .map((k) => `${k}=${JSON.stringify(values[k] ?? '')}`);
  return createHash('sha256')
    .update(lines.join('\n'))
    .digest('hex')
    .slice(0, 12);
}
