import { Injectable, BadRequestException } from '@nestjs/common';
import { validate as fluiValidate, catalogAppSchema } from '@flui-cloud/spec';
import { CatalogManifest } from '../interfaces/catalog-manifest.interface';

@Injectable()
export class CatalogSchemaValidatorService {
  /** Fields used by flui-core but not yet in the published `@flui-cloud/spec` schema: stripped before validation, re-attached after. Drop an entry once the spec ships it. */
  private static readonly FORWARD_COMPAT_FIELDS = [
    'persistence',
    'securityContext',
    'startCommand',
  ];

  getSchema(): unknown {
    return catalogAppSchema;
  }

  validate(parsed: unknown): CatalogManifest {
    const stripped = this.stripForwardCompatFields(parsed);

    const result = fluiValidate(stripped.value);
    if (!result.valid) {
      throw new BadRequestException({
        message: 'Invalid catalog manifest',
        errors: result.errors.map(
          (e) =>
            `${e.path} ${e.message}${e.params ? ' ' + JSON.stringify(e.params) : ''}`,
        ),
      });
    }
    if (result.manifest.kind !== 'CatalogApp') {
      throw new BadRequestException({
        message: 'Invalid catalog manifest',
        errors: [
          `<root> expected kind "CatalogApp", received "${result.manifest.kind}"`,
        ],
      });
    }
    const manifest = result.manifest as unknown as CatalogManifest;
    this.reattachForwardCompatFields(manifest, stripped.byPath);
    return manifest;
  }

  private stripForwardCompatFields(parsed: unknown): {
    value: unknown;
    byPath: Map<string, unknown>;
  } {
    const byPath = new Map<string, unknown>();
    if (!parsed || typeof parsed !== 'object') {
      return { value: parsed, byPath };
    }
    const clone = structuredClone(parsed) as Record<string, unknown>;
    const spec = (clone as { spec?: Record<string, unknown> }).spec;
    if (spec && typeof spec === 'object') {
      this.stripFrom(spec, 'spec', byPath);
      this.stripOidcForwardCompat(spec, byPath);
      const components = (spec as { components?: unknown[] }).components;
      if (Array.isArray(components)) {
        components.forEach((c, i) => {
          if (c && typeof c === 'object') {
            this.stripFrom(
              c as Record<string, unknown>,
              `spec.components[${i}]`,
              byPath,
            );
          }
        });
      }
    }
    return { value: clone, byPath };
  }

  private stripFrom(
    obj: Record<string, unknown>,
    path: string,
    byPath: Map<string, unknown>,
  ): void {
    for (const field of CatalogSchemaValidatorService.FORWARD_COMPAT_FIELDS) {
      if (field in obj) {
        byPath.set(`${path}::${field}`, obj[field]);
        delete obj[field];
      }
    }
  }

  private reattachForwardCompatFields(
    manifest: CatalogManifest,
    byPath: Map<string, unknown>,
  ): void {
    if (byPath.size === 0) return;
    const spec = manifest.spec as unknown as Record<string, unknown>;
    this.reattachTo(spec, 'spec', byPath);
    this.reattachOidcForwardCompat(spec, byPath);
    const components = (spec as { components?: unknown[] }).components;
    if (Array.isArray(components)) {
      components.forEach((c, i) => {
        if (c && typeof c === 'object') {
          this.reattachTo(
            c as Record<string, unknown>,
            `spec.components[${i}]`,
            byPath,
          );
        }
      });
    }
  }

  private reattachTo(
    obj: Record<string, unknown>,
    path: string,
    byPath: Map<string, unknown>,
  ): void {
    for (const field of CatalogSchemaValidatorService.FORWARD_COMPAT_FIELDS) {
      const v = byPath.get(`${path}::${field}`);
      if (v !== undefined) {
        obj[field] = v;
      }
    }
  }

  private getOidc(
    spec: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const auth = (spec as { auth?: Record<string, unknown> }).auth;
    const oidc = auth?.oidc;
    return oidc && typeof oidc === 'object'
      ? (oidc as Record<string, unknown>)
      : null;
  }

  // Nested forward-compat fields under `auth.oidc`; same strip/reattach as the top-level ones.
  private static readonly OIDC_FORWARD_COMPAT_FIELDS = [
    'targetComponent',
    'extraEnv',
  ];

  private stripOidcForwardCompat(
    spec: Record<string, unknown>,
    byPath: Map<string, unknown>,
  ): void {
    const oidc = this.getOidc(spec);
    if (!oidc) return;
    for (const field of CatalogSchemaValidatorService.OIDC_FORWARD_COMPAT_FIELDS) {
      if (field in oidc) {
        byPath.set(`spec.auth.oidc::${field}`, oidc[field]);
        delete oidc[field];
      }
    }
  }

  private reattachOidcForwardCompat(
    spec: Record<string, unknown>,
    byPath: Map<string, unknown>,
  ): void {
    const oidc = this.getOidc(spec);
    if (!oidc) return;
    for (const field of CatalogSchemaValidatorService.OIDC_FORWARD_COMPAT_FIELDS) {
      const v = byPath.get(`spec.auth.oidc::${field}`);
      if (v !== undefined) oidc[field] = v;
    }
  }
}
