import { BadRequestException } from '@nestjs/common';

type SourceRecord = Record<string, unknown>;

const CREDENTIAL_FIELDS = [
  'registryAuth',
  'registryAuthEncrypted',
  'hasRegistryAuth',
] as const;

function isRecord(value: unknown): value is SourceRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A registry credential in an application's source is refused: no deploy ever
 * read it, and a secret kept where every reader of the application passes by
 * is a risk with nothing in return. Private registries are a per-project
 * connection, not a field of each application.
 */
export function refuseRegistryAuth<T>(config: T): T {
  if (!isRecord(config)) return config;
  const auth = config.registryAuth;
  if (auth !== undefined && auth !== null && auth !== '') {
    throw new BadRequestException({
      code: 'REGISTRY_AUTH_NOT_SUPPORTED',
      message:
        'A registry credential cannot be set on an application. Deploying from an image takes public images; drop registryAuth from sourceConfig.',
    });
  }
  return withoutRegistryAuth(config);
}

/** The source with any credential field removed, whatever sent or stored it. */
export function withoutRegistryAuth<T>(config: T): T {
  if (!isRecord(config)) return config;
  if (!CREDENTIAL_FIELDS.some((field) => field in config)) return config;
  const copy = { ...config };
  for (const field of CREDENTIAL_FIELDS) delete copy[field];
  return copy as T;
}
