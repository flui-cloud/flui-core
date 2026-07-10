/**
 * The Application manifest (kind: Application) contract lives in the published
 * `@flui-cloud/spec` package — the single source of truth. Re-exported here so
 * existing imports keep working; do not re-declare the shape locally.
 */
export type {
  ApplicationManifest,
  ApplicationManifestEnvVar,
  ApplicationManifestResources,
  ApplicationManifestHealthcheck,
  ApplicationManifestScaling,
  ApplicationManifestDomain,
  ApplicationManifestVolume,
} from '@flui-cloud/spec';
