import { Injectable, BadRequestException } from '@nestjs/common';
import { validate as fluiValidate, catalogAppSchema } from '@flui-cloud/spec';
import {
  CatalogEnvVar,
  CatalogManifest,
} from '../interfaces/catalog-manifest.interface';
import {
  isKeyMaterial,
  keyMaterialProblems,
} from '../utils/catalog-key-material';
import { configFileTemplateProblems } from '../utils/catalog-config-file-templates';
import { udpPortProblems } from '../utils/catalog-ports.util';

const KEY_MATERIAL_PLACEHOLDER = { generate: 'secret', length: 32 };

@Injectable()
export class CatalogSchemaValidatorService {
  /** Fields used by flui-core but not yet in the published `@flui-cloud/spec` schema: stripped before validation, re-attached after. Drop an entry once the spec ships it. */
  private static readonly FORWARD_COMPAT_FIELDS = [
    'persistence',
    'securityContext',
    'startCommand',
    'configFiles',
    'command',
    'defaultCredentials',
    'engine',
    'imagePullPolicy',
    // Stripped and re-attached unvalidated until the published spec carries
    // it; the install path does its own checking of the shape.
    'companions',
    // Checked by `udpPortProblems` instead.
    'udpPorts',
  ];

  /** Spec-level fields forward-compatible on a building block only, where the published schema does not have them yet. */
  private static readonly BUILDING_BLOCK_FORWARD_COMPAT_FIELDS = ['options'];

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
    this.assertKeyMaterial(manifest);
    return manifest;
  }

  private envLists(
    spec: Record<string, unknown>,
  ): Array<{ path: string; env: CatalogEnvVar[] }> {
    const lists: Array<{ path: string; env: CatalogEnvVar[] }> = [];
    if (Array.isArray(spec.env)) {
      lists.push({ path: 'spec', env: spec.env as CatalogEnvVar[] });
    }
    const components = spec.components;
    if (Array.isArray(components)) {
      components.forEach((c: { env?: unknown }, i) => {
        if (Array.isArray(c?.env)) {
          lists.push({
            path: `spec.components[${i}]`,
            env: c.env as CatalogEnvVar[],
          });
        }
      });
    }
    return lists;
  }

  private stripKeyMaterial(
    spec: Record<string, unknown>,
    byPath: Map<string, unknown>,
  ): void {
    for (const { path, env } of this.envLists(spec)) {
      env.forEach((e, i) => {
        if (!isKeyMaterial(e.valueFrom)) return;
        byPath.set(`${path}.env[${i}]::valueFrom`, e.valueFrom);
        (e as { valueFrom: unknown }).valueFrom = KEY_MATERIAL_PLACEHOLDER;
      });
    }
  }

  private reattachKeyMaterial(
    spec: Record<string, unknown>,
    byPath: Map<string, unknown>,
  ): void {
    for (const { path, env } of this.envLists(spec)) {
      env.forEach((e, i) => {
        const original = byPath.get(`${path}.env[${i}]::valueFrom`);
        if (original !== undefined) {
          (e as { valueFrom: unknown }).valueFrom = original;
        }
      });
    }
  }

  private assertKeyMaterial(manifest: CatalogManifest): void {
    const spec = manifest.spec as unknown as Record<string, unknown>;
    const errors = [
      ...this.envLists(spec).flatMap(({ path, env }) =>
        keyMaterialProblems(env, path),
      ),
      ...(Array.isArray(spec.components)
        ? configFileTemplateProblems(spec.components)
        : []),
      ...udpPortProblems(spec),
    ];
    if (errors.length) {
      throw new BadRequestException({
        message: 'Invalid catalog manifest',
        errors,
      });
    }
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
      if (spec.type === 'building-block') {
        for (const field of CatalogSchemaValidatorService.BUILDING_BLOCK_FORWARD_COMPAT_FIELDS) {
          if (field in spec) {
            byPath.set(`spec::${field}`, spec[field]);
            delete spec[field];
          }
        }
      }
      this.stripOidcForwardCompat(spec, byPath);
      this.stripPostInstallComponent(spec, byPath);
      this.stripKeyMaterial(spec, byPath);
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
    for (const field of CatalogSchemaValidatorService.BUILDING_BLOCK_FORWARD_COMPAT_FIELDS) {
      const v = byPath.get(`spec::${field}`);
      if (v !== undefined) spec[field] = v;
    }
    this.reattachOidcForwardCompat(spec, byPath);
    this.reattachPostInstallComponent(spec, byPath);
    this.reattachKeyMaterial(spec, byPath);
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

  private postInstallExecs(
    spec: Record<string, unknown>,
  ): Array<Record<string, unknown> | null> {
    const steps = spec.postInstall;
    if (!Array.isArray(steps)) return [];
    return steps.map((s: { exec?: unknown }) =>
      s?.exec && typeof s.exec === 'object'
        ? (s.exec as Record<string, unknown>)
        : null,
    );
  }

  private stripPostInstallComponent(
    spec: Record<string, unknown>,
    byPath: Map<string, unknown>,
  ): void {
    this.postInstallExecs(spec).forEach((exec, i) => {
      if (!exec || !('component' in exec)) return;
      byPath.set(`spec.postInstall[${i}].exec::component`, exec.component);
      delete exec.component;
    });
  }

  private reattachPostInstallComponent(
    spec: Record<string, unknown>,
    byPath: Map<string, unknown>,
  ): void {
    this.postInstallExecs(spec).forEach((exec, i) => {
      const v = byPath.get(`spec.postInstall[${i}].exec::component`);
      if (exec && v !== undefined) exec.component = v;
    });
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
