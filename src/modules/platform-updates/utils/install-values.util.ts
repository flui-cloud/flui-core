import { createHash } from 'node:crypto';
import { sha256 } from './manifest-eligibility.util';
import { byBytes, documentsOf } from './manifest-documents.util';
import {
  InstallTransforms,
  placeholdersIn,
  renderManifestFile,
  valuesDigest,
} from './manifest-render.util';
import { bareRepository } from './declared-image.util';

export const INSTALL_VALUES_NAMESPACE = 'kube-system';
export const INSTALL_VALUES_NAME = 'flui-install-values';
export const INSTALL_VALUES_SCHEMA = '1';

/** What `kube-system/flui-install-values` says about how a master was built. */
export interface InstallRecord {
  schema: string;
  /** `installer` when the installer wrote it; `reconstructed` when Flui proved it later. */
  source: 'installer' | 'reconstructed';
  bootstrapRef: string | null;
  releaseVersion: string | null;
  clusterType: string | null;
  k3sVersion: string | null;
  /** Absent when the installer could not tell secret variables from the rest. */
  values?: Record<string, string>;
  secretRefs: Record<string, string[]>;
  transforms: InstallTransforms;
  rendered: Record<string, string>;
}

const nonEmpty = (v: string | undefined): string | null =>
  v?.trim() ? v.trim() : null;

function parseJson<T>(text: string | undefined, fallback: T): T {
  if (text === undefined) return fallback;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as T)
      : fallback;
  } catch {
    return fallback;
  }
}

const stringRecord = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries((value ?? {}) as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    ),
  );

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

/** Reads the ConfigMap's data; null when there is no usable record. */
export function parseInstallRecord(
  data: Record<string, string> | undefined | null,
  labels: Record<string, string> = {},
): InstallRecord | null {
  if (!data?.schema) return null;
  const transforms = parseJson<Record<string, unknown>>(
    data['transforms.json'],
    {},
  );
  const tls = transforms.ingressTls as
    | { secretName?: unknown; files?: unknown }
    | undefined;
  const secretRefs = parseJson<Record<string, unknown>>(
    data['secretRefs.json'],
    {},
  );
  return {
    schema: data.schema,
    source:
      labels['flui.cloud/install-values-source'] === 'reconstructed'
        ? 'reconstructed'
        : 'installer',
    bootstrapRef: nonEmpty(data.bootstrapRef),
    releaseVersion: nonEmpty(data.releaseVersion),
    clusterType: nonEmpty(data.clusterType),
    k3sVersion: nonEmpty(data.k3sVersion),
    values:
      data['values.json'] === undefined
        ? undefined
        : stringRecord(parseJson(data['values.json'], {})),
    secretRefs: Object.fromEntries(
      Object.entries(secretRefs).map(([k, v]) => [k, stringList(v)]),
    ),
    transforms: {
      raw: stringList(transforms.raw),
      ...(tls && typeof tls.secretName === 'string'
        ? {
            ingressTls: {
              secretName: tls.secretName,
              files: stringList(tls.files),
            },
          }
        : {}),
    },
    rendered: stringRecord(parseJson(data['rendered.json'], {})),
  };
}

/** `manifests/SECRETS`: variable → every `namespace/secret/key` it lives at. */
export function parseSecretsIndex(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [variable, location] = line.split(/\s+/);
    if (!variable || !/^[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(location ?? '')) {
      continue;
    }
    out.set(variable, [...(out.get(variable) ?? []), location]);
  }
  return out;
}

/**
 * The files whose rendered copy may hold a secret value: their template names a
 * variable listed as secret. With no list at all, any placeholder counts —
 * a file is only read back when it is known to be safe to.
 */
export function secretBearingFiles(
  templates: Iterable<{ name: string; template: string }>,
  secretVariables: ReadonlySet<string> | null,
): string[] {
  const out = new Set<string>();
  for (const { name, template } of templates) {
    const names = placeholdersIn(template);
    if (
      secretVariables === null
        ? names.length > 0
        : names.some((n) => secretVariables.has(n))
    ) {
      out.add(name);
    }
  }
  return [...out].sort(byBytes);
}

export interface ImageTagSlot {
  variable: string;
  kind: string;
  name: string;
  namespace: string;
  container: string;
  repository: string;
}

/** Container images whose tag is a placeholder, as `repo:${VAR}`. */
export function imageTagSlots(template: string): ImageTagSlot[] {
  let docs: unknown[];
  try {
    docs = documentsOf(template);
  } catch {
    return [];
  }
  const slots: ImageTagSlot[] = [];
  for (const doc of docs) {
    const d = (doc ?? {}) as Record<string, any>;
    if (!['Deployment', 'StatefulSet', 'DaemonSet'].includes(d.kind)) continue;
    const containers: unknown[] = d.spec?.template?.spec?.containers ?? [];
    for (const c of containers) {
      const container = (c ?? {}) as Record<string, any>;
      const image = container.image;
      if (typeof image !== 'string') continue;
      const match = /^(.+):\$\{([A-Za-z_]\w*)\}$/.exec(image);
      if (!match) continue;
      slots.push({
        variable: match[2],
        kind: String(d.kind),
        name: String(d.metadata?.name ?? ''),
        namespace: String(d.metadata?.namespace ?? 'default'),
        container: String(container.name ?? ''),
        repository: match[1],
      });
    }
  }
  return slots;
}

/** The tag a running image carries for a slot, when it is the same repository. */
export function tagForSlot(
  slot: ImageTagSlot,
  runningImage: string | null | undefined,
): string | null {
  if (!runningImage) return null;
  const withoutDigest = runningImage.split('@')[0];
  const colon = withoutDigest.lastIndexOf(':');
  if (colon <= 0) return null;
  const tag = withoutDigest.slice(colon + 1);
  if (!tag || tag.includes('/')) return null;
  const repository = withoutDigest.slice(0, colon);
  return bareRepository(repository) === bareRepository(slot.repository)
    ? tag
    : null;
}

export interface ProofFile {
  name: string;
  /** Candidate templates, one per release that may have rendered this file. */
  templates: Array<{ ref: string; template: string }>;
  masterSha: string;
  raw: boolean;
}

export interface FileProof {
  name: string;
  proven: boolean;
  ref?: string;
  values?: Record<string, string>;
  ingressTls?: boolean;
  reason?: string;
}

export interface ProofResult {
  files: FileProof[];
  /** Every value some proven file was rendered with, and no other file disputes. */
  values: Record<string, string>;
  /** Why a variable has no proven value, when some file needs one. */
  unproven: Record<string, string>;
  /** Files proven with their IngressRoute bound to the system certificate. */
  ingressTlsFiles: string[];
}

const MAX_COMBINATIONS = 4096;

function* combinations(
  names: string[],
  candidates: Readonly<Record<string, string[]>>,
): Generator<Record<string, string>> {
  if (names.length === 0) {
    yield {};
    return;
  }
  const [head, ...rest] = names;
  for (const value of candidates[head]) {
    for (const tail of combinations(rest, candidates)) {
      yield { [head]: value, ...tail };
    }
  }
}

function agreedValues(files: FileProof[]): {
  values: Record<string, string>;
  unproven: Record<string, string>;
} {
  const values: Record<string, string> = {};
  const unproven: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const proof of files) {
    if (!proof.proven || !proof.values) continue;
    for (const [k, v] of Object.entries(proof.values)) {
      if (unproven[k]) continue;
      if (values[k] !== undefined && values[k] !== v) {
        unproven[k] =
          `${sources[k]} and ${proof.name} were rendered with different values`;
        delete values[k];
        continue;
      }
      values[k] = v;
      sources[k] = sources[k] ?? proof.name;
    }
  }
  return { values, unproven };
}

function markUnprovable(
  files: FileProof[],
  inputs: ProofFile[],
  values: Record<string, string>,
  unproven: Record<string, string>,
): void {
  for (const proof of files) {
    if (proof.proven) continue;
    const templates = inputs.find((f) => f.name === proof.name)?.templates;
    for (const { template } of templates ?? []) {
      for (const k of placeholdersIn(template)) {
        if (values[k] === undefined && !unproven[k]) {
          unproven[k] = `${proof.name}: ${proof.reason}`;
        }
      }
    }
  }
}

/**
 * Which values rendered what the master holds, proven one file at a time. A
 * file nothing reproduces is left unproven, and so is every value only it
 * could have vouched for.
 */
export function proveInstallValues(input: {
  files: ProofFile[];
  candidates: Readonly<Record<string, string[]>>;
  ingressTls?: { secretName: string };
  secretVariables: ReadonlySet<string>;
}): ProofResult {
  const candidates: Record<string, string[]> = {};
  for (const [k, list] of Object.entries(input.candidates)) {
    candidates[k] = [...new Set(list)];
  }

  const files = input.files.map((file) => proveFile(file, candidates, input));
  const { values, unproven } = agreedValues(files);
  markUnprovable(files, input.files, values, unproven);
  return {
    files,
    values,
    unproven,
    ingressTlsFiles: files
      .filter((f) => f.proven && f.ingressTls)
      .map((f) => f.name)
      .sort(byBytes),
  };
}

function proveFile(
  file: ProofFile,
  candidates: Record<string, string[]>,
  input: {
    ingressTls?: { secretName: string };
    secretVariables: ReadonlySet<string>;
  },
): FileProof {
  if (file.templates.length === 0) {
    return {
      name: file.name,
      proven: false,
      reason: 'no release this installation may have come from ships it',
    };
  }
  let reason = "no candidate values reproduce the master's copy";
  const tlsOptions = input.ingressTls
    ? [undefined, { ...input.ingressTls, files: [file.name] }]
    : [undefined];
  for (const { ref, template } of file.templates) {
    if (file.raw) {
      if (sha256(template) === file.masterSha) {
        return { name: file.name, proven: true, ref, values: {} };
      }
      continue;
    }
    const names = placeholdersIn(template);
    const refusal = whyNotTried(names, candidates, input.secretVariables);
    if (refusal) {
      reason = refusal;
      continue;
    }
    const proof = firstReproduction(
      file,
      ref,
      template,
      combinations(names, candidates),
      tlsOptions,
    );
    if (proof) return proof;
  }
  return { name: file.name, proven: false, reason };
}

function whyNotTried(
  names: string[],
  candidates: Record<string, string[]>,
  secretVariables: ReadonlySet<string>,
): string | undefined {
  const secret = names.filter((n) => secretVariables.has(n));
  if (secret.length > 0) return `renders ${secret.join(', ')}, a secret`;
  const lacking = names.filter((n) => !candidates[n]?.length);
  if (lacking.length > 0) {
    return `no candidate value for ${lacking.join(', ')}`;
  }
  const count = names.reduce((n, k) => n * candidates[k].length, 1);
  if (count > MAX_COMBINATIONS) return 'too many candidate values to try';
  return undefined;
}

function firstReproduction(
  file: ProofFile,
  ref: string,
  template: string,
  combos: Iterable<Record<string, string>>,
  tlsOptions: Array<{ secretName: string; files: string[] } | undefined>,
): FileProof | undefined {
  for (const combo of combos) {
    for (const ingressTls of tlsOptions) {
      const rendered = renderManifestFile(
        file.name,
        template,
        combo,
        ingressTls ? { ingressTls } : {},
      );
      if (sha256(rendered) === file.masterSha) {
        return {
          name: file.name,
          proven: true,
          ref,
          values: combo,
          ingressTls: ingressTls !== undefined,
        };
      }
    }
  }
  return undefined;
}

/** One value for a proof: what was proven, from which copies, with what. */
export function proofDigest(
  ref: string | null,
  masterShas: Array<[string, string]>,
  result: ProofResult,
): string {
  const lines = [
    ref ?? '-',
    valuesDigest(result.values),
    ...result.ingressTlsFiles,
    ...masterShas.map(([n, s]) => `${n} ${s}`).sort(byBytes),
    ...result.files
      .map((f) => `${f.name} ${f.proven ? f.ref : '-'}`)
      .sort(byBytes),
  ];
  return createHash('sha256')
    .update(lines.join('\n'))
    .digest('hex')
    .slice(0, 12);
}
