import { BadRequestException } from '@nestjs/common';
import * as yaml from 'js-yaml';
import { validate, type FluiValidationWarning } from '@flui-cloud/spec';
import { ApplicationManifest } from '../interfaces/application-manifest.interface';

export interface ApplicationManifestResult {
  manifest: ApplicationManifest;
  /**
   * Non-fatal advisories: fields the spec accepts but the runtime does not yet
   * apply (`x-flui-status: planned`). Surfaced to the user; never block a deploy.
   */
  warnings: FluiValidationWarning[];
}

/**
 * Parses and validates a raw flui.yaml manifest (kind: Application) against the
 * published `@flui-cloud/spec` schema — the single source of truth shared by the
 * source-deploy pipeline and the repository manifest lookup.
 *
 * @throws BadRequestException when the YAML is invalid or violates the schema
 * (all schema errors are reported at once).
 */
export function validateApplicationManifest(
  raw: string,
): ApplicationManifestResult {
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new BadRequestException(`Invalid YAML: ${err.message}`);
  }

  const result = validate(parsed);
  if (!result.valid) {
    throw new BadRequestException(
      result.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
    );
  }
  if (result.manifest.kind !== 'Application') {
    throw new BadRequestException(
      `Expected kind: Application, got: ${result.manifest.kind}`,
    );
  }

  return { manifest: result.manifest, warnings: result.warnings };
}

/**
 * Throwing convenience for call sites that only need the manifest and do not
 * surface warnings.
 */
export function parseApplicationManifest(raw: string): ApplicationManifest {
  return validateApplicationManifest(raw).manifest;
}
