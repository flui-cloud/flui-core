import { BadRequestException } from '@nestjs/common';
import type { ApplicationEntity } from '../entities/application.entity';
import type {
  CompanionsSpec,
  SidecarSpec,
} from '../services/application-manifest-generator.service';

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const ENV_NAME = /^[-._a-zA-Z][-._a-zA-Z0-9]*$/;
const SECRET_KEY = /^[-._a-zA-Z0-9]+$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@+]*$/;
const QUANTITY = /^\d+(\.\d+)?(m|k|[KMGTPE]i?|[eE]\d+)?$/;
const MOUNT_PATH = /^\/[A-Za-z0-9._\-/@+=~]*$/;
const HTTP_PATH = /^\/[A-Za-z0-9._\-/~%?&=+:@!$*,;]*$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const LABEL_KEY =
  /^([a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const CRON = /^[0-9A-Za-z*/,\-? #@]+$/;
const PULL_POLICIES = new Set(['Always', 'IfNotPresent', 'Never']);
const CONCURRENCY = new Set(['Allow', 'Forbid', 'Replace']);

type Check = (value: string) => boolean;

const re =
  (pattern: RegExp): Check =>
  (value) =>
    pattern.test(value);

type GuardedApp = Pick<
  ApplicationEntity,
  | 'slug'
  | 'k8sNamespace'
  | 'env'
  | 'volumes'
  | 'configFiles'
  | 'labels'
  | 'resources'
  | 'securityContext'
  | 'healthProbe'
  | 'port'
  | 'replicas'
  | 'dedicatedNodeName'
  | 'sourceConfig'
  | 'scaling'
> & { companions?: CompanionsSpec };

/** Collects what is wrong, in the words a person reads. */
class Findings {
  readonly problems: string[] = [];

  check(what: string, value: unknown, valid: Check): void {
    if (value === undefined || value === null || value === '') return;
    if (typeof value !== 'string' || !valid(value)) {
      this.problems.push(`${what} ${JSON.stringify(value)} is not valid here`);
    }
  }

  integer(what: string, value: unknown, min: number, max: number): void {
    if (value === undefined || value === null) return;
    const n = value as number;
    if (!Number.isInteger(value) || n < min || n > max) {
      this.problems.push(
        `${what} ${JSON.stringify(value)} must be a whole number from ${min} to ${max}`,
      );
    }
  }
}

function checkIdentity(app: GuardedApp, f: Findings, imageRef?: string): void {
  if (typeof app.slug !== 'string' || !DNS_LABEL.test(app.slug)) {
    f.problems.push(
      `slug ${JSON.stringify(app.slug)} must be lowercase letters, digits and dashes`,
    );
  }
  f.check('namespace', app.k8sNamespace, re(DNS_LABEL));
  f.check('image', imageRef, re(IMAGE));
  const source = app.sourceConfig as
    | { pullPolicy?: unknown; imageRef?: unknown }
    | undefined;
  f.check('image', source?.imageRef, re(IMAGE));
  f.check('pull policy', source?.pullPolicy, (v) => PULL_POLICIES.has(v));
  f.check('node', app.dedicatedNodeName, re(DNS_SUBDOMAIN));
  f.integer('port', app.port, 1, 65535);
  f.integer('replicas', app.replicas, 0, 1000);
  for (const [key, value] of Object.entries(app.labels ?? {})) {
    f.check('label', key, re(LABEL_KEY));
    if (typeof value !== 'string') f.problems.push(`label ${key} must be text`);
  }
}

function checkStorageAndEnv(app: GuardedApp, f: Findings): void {
  for (const e of app.env ?? []) {
    f.check('variable', e.name, re(ENV_NAME));
    f.check('secret', e.externalSecretRef?.secretName, re(DNS_SUBDOMAIN));
    f.check('secret key', e.externalSecretRef?.key, re(SECRET_KEY));
  }
  for (const v of app.volumes ?? []) {
    f.check('volume', v.name, re(DNS_LABEL));
    f.check('mount path', v.mountPath, re(MOUNT_PATH));
    f.check('volume size', v.size, re(QUANTITY));
    f.check('storage class', v.storageClass, re(DNS_SUBDOMAIN));
    f.check('claim', v.claimNameOverride, re(DNS_SUBDOMAIN));
  }
  for (const file of app.configFiles ?? []) {
    f.check('file path', file.path, re(MOUNT_PATH));
  }
  const r = app.resources;
  for (const [what, value] of [
    ['cpu request', r?.cpu?.request],
    ['cpu limit', r?.cpu?.limit],
    ['memory request', r?.memory?.request],
    ['memory limit', r?.memory?.limit],
    ['ephemeral storage request', r?.ephemeralStorage?.request],
    ['ephemeral storage limit', r?.ephemeralStorage?.limit],
  ] as const) {
    f.check(what, value, re(QUANTITY));
  }
}

function checkRuntime(app: GuardedApp, f: Findings): void {
  const sc = app.securityContext;
  f.integer('fsGroup', sc?.fsGroup, 0, 2147483647);
  f.integer('runAsUser', sc?.runAsUser, 0, 2147483647);
  f.integer('runAsGroup', sc?.runAsGroup, 0, 2147483647);
  if (sc?.runAsNonRoot !== undefined && typeof sc.runAsNonRoot !== 'boolean') {
    f.problems.push('runAsNonRoot must be true or false');
  }
  const probe = app.healthProbe;
  f.check('probe path', probe?.httpPath, re(HTTP_PATH));
  f.integer('probe port', probe?.httpPort, 1, 65535);
  f.integer('probe port', probe?.tcpPort, 1, 65535);
  for (const name of Object.keys(probe?.httpHeaders ?? {})) {
    f.check('probe header', name, re(HEADER_NAME));
  }
}

function checkScaling(app: GuardedApp, f: Findings): void {
  const scaling = app.scaling;
  f.integer('autoscaling minimum', scaling?.minReplicas, 0, 1000);
  f.integer('autoscaling maximum', scaling?.maxReplicas, 0, 1000);
  f.integer('CPU target', scaling?.targetCPU, 1, 1000);
  f.integer('memory target', scaling?.targetMemory, 1, 1000);
  f.integer('autoscaling minimum', scaling?.horizontal?.min, 0, 1000);
  f.integer('autoscaling maximum', scaling?.horizontal?.max, 0, 1000);
  for (const m of scaling?.horizontal?.metrics ?? []) {
    f.check('autoscaling metric', m.type, (v) => v === 'cpu' || v === 'memory');
    f.integer('autoscaling target', m.utilization, 1, 1000);
  }
  for (const [what, policy] of [
    ['scale-up', scaling?.horizontal?.behavior?.scaleUp],
    ['scale-down', scaling?.horizontal?.behavior?.scaleDown],
  ] as const) {
    f.integer(`${what} window`, policy?.stabilizationWindowSeconds, 0, 3600);
    f.integer(`${what} step`, policy?.step, 1, 1000);
  }
}

function checkSidecar(
  s: SidecarSpec,
  f: Findings,
  filled: (name: string) => string,
): void {
  f.check(
    'companion',
    typeof s.name === 'string' ? filled(s.name) : s.name,
    re(DNS_LABEL),
  );
  f.check('companion image', s.image, re(IMAGE));
  f.check('companion pull policy', s.imagePullPolicy, (v) =>
    PULL_POLICIES.has(v),
  );
  for (const q of [s.cpuRequest, s.memoryRequest, s.cpuLimit, s.memoryLimit]) {
    f.check('companion quantity', q, re(QUANTITY));
  }
  for (const e of s.env ?? []) {
    f.check('companion variable', e.name, re(ENV_NAME));
    f.check('companion secret', e.secretRef?.name, (v) =>
      DNS_SUBDOMAIN.test(filled(v)),
    );
    f.check('companion secret key', e.secretRef?.key, re(SECRET_KEY));
  }
  for (const m of s.mounts ?? []) {
    f.check('companion mount', m.name, re(DNS_LABEL));
    f.check('companion mount path', m.mountPath, re(MOUNT_PATH));
  }
}

function checkCompanions(app: GuardedApp, f: Findings): void {
  const companions = app.companions;
  const filled = (name: string) => name.replaceAll('{{SLUG}}', app.slug ?? '');
  for (const s of [
    ...(companions?.initContainers ?? []),
    ...(companions?.sidecars ?? []),
  ]) {
    checkSidecar(s, f, filled);
  }
  for (const v of companions?.volumes ?? []) {
    f.check('companion volume', v.name, re(DNS_LABEL));
    f.check('companion secret', v.secret?.secretName, (value) =>
      DNS_SUBDOMAIN.test(filled(value)),
    );
    f.check('companion volume size', v.emptyDir?.sizeLimit, re(QUANTITY));
  }
}

/**
 * Every string a manifest spells as a name, path, image or quantity, checked
 * against what Kubernetes itself accepts there. The generator writes YAML text
 * that is applied with the cluster's admin credentials, so a quote, a newline
 * or a document separator in one of these fields must never reach it.
 */
export function manifestInputProblems(
  app: GuardedApp,
  extra: { imageRef?: string } = {},
): string[] {
  const findings = new Findings();
  checkIdentity(app, findings, extra.imageRef);
  checkStorageAndEnv(app, findings);
  checkRuntime(app, findings);
  checkScaling(app, findings);
  checkCompanions(app, findings);
  return findings.problems;
}

export function assertManifestInputs(
  app: Parameters<typeof manifestInputProblems>[0],
  extra: { imageRef?: string } = {},
): void {
  const problems = manifestInputProblems(app, extra);
  if (problems.length) {
    throw new BadRequestException(
      `This application cannot be deployed as it is: ${problems.join('; ')}`,
    );
  }
}

export function cronInputProblems(spec: {
  name: string;
  schedule: string;
  concurrencyPolicy?: string;
}): string[] {
  const problems: string[] = [];
  if (!DNS_LABEL.test(spec.name ?? ''))
    problems.push(`job name ${JSON.stringify(spec.name)} is not valid`);
  if (!CRON.test(spec.schedule ?? ''))
    problems.push(`schedule ${JSON.stringify(spec.schedule)} is not valid`);
  if (
    spec.concurrencyPolicy !== undefined &&
    !CONCURRENCY.has(spec.concurrencyPolicy)
  ) {
    problems.push(
      `concurrency policy ${JSON.stringify(spec.concurrencyPolicy)} is not valid`,
    );
  }
  return problems;
}
