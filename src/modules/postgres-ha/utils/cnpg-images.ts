import { createHash } from 'node:crypto';
import { CNPG_VERSION } from '../postgres-ha.constants';

/** The SHA-256 of the 1.30.1 release manifest: a manifest that differs is refused. */
export const CNPG_MANIFEST_SHA256 =
  '37237f145d8138256ea25ae830f87759255665ff08f8d552fdd8224a5ec032fb';

const OPERATOR_IMAGE = `ghcr.io/cloudnative-pg/cloudnative-pg:${CNPG_VERSION}`;

/** The operator's image by the digest GHCR served on 8 November 2026; a tag can be moved, a digest cannot. */
export const CNPG_OPERATOR_IMAGE_DIGEST =
  'sha256:923c267ec29636db3bee20f993d0ec4973fa22998e1adad37da79e4d32b5bc07';

/**
 * The release manifest with the operator's image fixed by digest, in its
 * container and in the variable it hands to every instance it starts, after
 * checking it is the manifest that digest was read for.
 */
export function pinnedCnpgManifest(
  manifest: string,
  expectedSha256 = CNPG_MANIFEST_SHA256,
): string {
  const sha = createHash('sha256').update(manifest).digest('hex');
  if (sha !== expectedSha256) {
    throw new Error(
      `The CloudNativePG manifest is not the one Flui checked (SHA-256 ${sha}): refusing to install it`,
    );
  }
  return manifest
    .split(OPERATOR_IMAGE)
    .join(`${OPERATOR_IMAGE}@${CNPG_OPERATOR_IMAGE_DIGEST}`);
}
