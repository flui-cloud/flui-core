import {
  RSA_KEY_BITS,
  RSA_KEY_FORMATS,
} from '../../../common/utils/self-signed-certificate.util';
import {
  CatalogEnvVar,
  CatalogValueFrom,
  CatalogValueFromBcrypt,
  CatalogValueFromCertificate,
  CatalogValueFromGeneratedKey,
} from '../interfaces/catalog-manifest.interface';

export const DEFAULT_KEY_BITS = 4096;
export const DEFAULT_CERTIFICATE_DAYS = 3650;
const MAX_CERTIFICATE_DAYS = 36500;
const MAX_COMMON_NAME_LENGTH = 64;

export type CatalogKeyMaterial =
  | CatalogValueFromGeneratedKey
  | CatalogValueFromCertificate
  | CatalogValueFromBcrypt;

export function isGeneratedKey(
  vf: CatalogValueFrom | undefined,
): vf is CatalogValueFromGeneratedKey {
  return !!vf && 'generate' in vf && vf.generate === 'rsa-private-key';
}

export function isCertificate(
  vf: CatalogValueFrom | undefined,
): vf is CatalogValueFromCertificate {
  return !!vf && 'certificateFor' in vf;
}

export function isBcrypt(
  vf: CatalogValueFrom | undefined,
): vf is CatalogValueFromBcrypt {
  return !!vf && 'bcryptOf' in vf;
}

export function isKeyMaterial(
  vf: CatalogValueFrom | undefined,
): vf is CatalogKeyMaterial {
  return isGeneratedKey(vf) || isCertificate(vf) || isBcrypt(vf);
}

function isHashableSecret(vf: CatalogValueFrom | undefined): boolean {
  if (!vf) return false;
  if ('generate' in vf) return vf.generate === 'secret';
  return 'userInput' in vf && !!vf.userInput.sensitive;
}

function unknownFields(vf: object, allowed: string[]): string[] {
  const extra = Object.keys(vf).filter((k) => !allowed.includes(k));
  return extra.length ? [`has unknown fields ${extra.join(', ')}`] : [];
}

function keyProblems(vf: CatalogValueFromGeneratedKey): string[] {
  const problems = unknownFields(vf, ['generate', 'bits', 'format']);
  if (vf.bits !== undefined && !RSA_KEY_BITS.includes(vf.bits)) {
    problems.push(`bits must be one of ${RSA_KEY_BITS.join(', ')}`);
  }
  if (vf.format !== undefined && !RSA_KEY_FORMATS.includes(vf.format)) {
    problems.push(`format must be one of ${RSA_KEY_FORMATS.join(', ')}`);
  }
  return problems;
}

function bcryptProblems(
  vf: CatalogValueFromBcrypt,
  hashable: Set<string>,
): string[] {
  const problems = unknownFields(vf, ['bcryptOf']);
  if (!hashable.has(vf.bcryptOf)) {
    problems.push(
      `bcryptOf "${vf.bcryptOf}" is not a generated secret or sensitive input of the same component`,
    );
  }
  return problems;
}

function validDaysOk(days: unknown): boolean {
  return (
    days === undefined ||
    (Number.isInteger(days) &&
      (days as number) >= 1 &&
      (days as number) <= MAX_CERTIFICATE_DAYS)
  );
}

function commonNameOk(name: unknown): boolean {
  return (
    name === undefined ||
    (typeof name === 'string' &&
      !!name.trim() &&
      name.length <= MAX_COMMON_NAME_LENGTH)
  );
}

function certificateProblems(
  vf: CatalogValueFromCertificate,
  keys: Set<string>,
): string[] {
  const problems = unknownFields(vf, [
    'certificateFor',
    'commonName',
    'validDays',
  ]);
  if (!keys.has(vf.certificateFor)) {
    problems.push(
      `certificateFor "${vf.certificateFor}" is not a generated rsa-private-key of the same component`,
    );
  }
  if (!validDaysOk(vf.validDays)) {
    problems.push(
      `validDays must be a whole number from 1 to ${MAX_CERTIFICATE_DAYS}`,
    );
  }
  if (!commonNameOk(vf.commonName)) {
    problems.push(
      `commonName must be 1 to ${MAX_COMMON_NAME_LENGTH} characters`,
    );
  }
  return problems;
}

/** What is wrong with the key material of one env list, each problem prefixed with its path. */
export function keyMaterialProblems(
  env: CatalogEnvVar[],
  path: string,
): string[] {
  const keys = new Set(
    env.filter((e) => isGeneratedKey(e.valueFrom)).map((e) => e.name),
  );
  const hashable = new Set(
    env.filter((e) => isHashableSecret(e.valueFrom)).map((e) => e.name),
  );
  return env.flatMap((e, i) => {
    const vf = e.valueFrom;
    let problems: string[] = [];
    if (isGeneratedKey(vf)) problems = keyProblems(vf);
    else if (isBcrypt(vf)) problems = bcryptProblems(vf, hashable);
    else if (isCertificate(vf)) problems = certificateProblems(vf, keys);
    return problems.map((p) => `${path}.env[${i}] (${e.name}) ${p}`);
  });
}
