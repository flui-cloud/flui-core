import { ApplicationManifest } from '@flui-cloud/spec';
import {
  applyDeployOverrides,
  collectOverrideShadows,
  DEPLOY_OVERRIDES_METADATA_KEY,
  hasDeployOverrides,
  mergeDeployOverrides,
  readStoredOverrides,
} from './deploy-overrides.util';

const baseManifest = (): ApplicationManifest =>
  ({
    apiVersion: 'flui.cloud/v1beta1',
    kind: 'Application',
    metadata: { name: 'gojodigital' },
    deploy: {
      port: 80,
      exposure: 'public',
      domain: { fqdn: 'gojodigital.com', tls: true, certChallenge: 'dns-01' },
    },
  }) as unknown as ApplicationManifest;

describe('deploy overrides', () => {
  describe('applyDeployOverrides', () => {
    it('returns the manifest untouched when there is nothing to override', () => {
      const manifest = baseManifest();
      expect(applyDeployOverrides(manifest, undefined)).toBe(manifest);
      expect(applyDeployOverrides(manifest, {})).toBe(manifest);
      expect(applyDeployOverrides(manifest, { domain: {} })).toBe(manifest);
    });

    it('overrides name, exposure and domain without mutating the input', () => {
      const manifest = baseManifest();
      const result = applyDeployOverrides(manifest, {
        name: 'gojodigital-staging',
        exposure: 'internal',
        domain: { fqdn: 'staging.gojodigital.com' },
      });

      expect(result.metadata.name).toBe('gojodigital-staging');
      expect(result.deploy.exposure).toBe('internal');
      expect(result.deploy.domain?.fqdn).toBe('staging.gojodigital.com');
      // untouched manifest keys survive the domain override
      expect(result.deploy.domain?.certChallenge).toBe('dns-01');
      expect(result.deploy.port).toBe(80);

      expect(manifest.metadata.name).toBe('gojodigital');
      expect(manifest.deploy.domain?.fqdn).toBe('gojodigital.com');
    });

    it('creates the domain block when the manifest has none', () => {
      const manifest = baseManifest();
      delete manifest.deploy.domain;
      const result = applyDeployOverrides(manifest, {
        domain: { fqdn: 'app.example.com' },
      });
      expect(result.deploy.domain).toEqual({ fqdn: 'app.example.com' });
    });
  });

  describe('mergeDeployOverrides', () => {
    it('lets the incoming override win field by field', () => {
      const merged = mergeDeployOverrides(
        { name: 'old', exposure: 'public', domain: { fqdn: 'a.example.com' } },
        { exposure: 'internal' },
      );
      expect(merged).toEqual({
        name: 'old',
        exposure: 'internal',
        domain: { fqdn: 'a.example.com' },
      });
    });

    it('merges the domain per key so a partial override keeps the rest', () => {
      const merged = mergeDeployOverrides(
        { domain: { fqdn: 'a.example.com', certChallenge: 'dns-01' } },
        { domain: { fqdn: 'b.example.com' } },
      );
      expect(merged.domain).toEqual({
        fqdn: 'b.example.com',
        certChallenge: 'dns-01',
      });
    });

    it('never lets an undefined incoming field blank a stored one', () => {
      const merged = mergeDeployOverrides(
        { name: 'kept', domain: { fqdn: 'a.example.com' } },
        { name: undefined, domain: { fqdn: undefined } },
      );
      expect(merged).toEqual({
        name: 'kept',
        domain: { fqdn: 'a.example.com' },
      });
    });

    it('yields no domain key when neither side has one', () => {
      expect(mergeDeployOverrides(null, { exposure: 'public' })).toEqual({
        exposure: 'public',
      });
    });
  });

  describe('collectOverrideShadows', () => {
    it('reports every manifest value an override masks', () => {
      const shadows = collectOverrideShadows(baseManifest(), {
        name: 'gojodigital-staging',
        exposure: 'internal',
        domain: { fqdn: 'staging.gojodigital.com' },
      });
      expect(shadows).toEqual([
        'metadata.name "gojodigital" -> "gojodigital-staging"',
        'deploy.exposure "public" -> "internal"',
        'deploy.domain.fqdn "gojodigital.com" -> "staging.gojodigital.com"',
      ]);
    });

    it('stays silent when the override matches the manifest or fills a gap', () => {
      const manifest = baseManifest();
      delete manifest.deploy.domain;
      expect(
        collectOverrideShadows(manifest, {
          name: 'gojodigital',
          exposure: 'public',
          domain: { fqdn: 'app.example.com' },
        }),
      ).toEqual([]);
    });
  });

  describe('readStoredOverrides', () => {
    it('reads the object form and the legacy JSON string form', () => {
      const value = { domain: { fqdn: 'a.example.com' } };
      expect(
        readStoredOverrides({ [DEPLOY_OVERRIDES_METADATA_KEY]: value }),
      ).toEqual(value);
      expect(
        readStoredOverrides({
          [DEPLOY_OVERRIDES_METADATA_KEY]: JSON.stringify(value),
        }),
      ).toEqual(value);
    });

    it('returns null for absent or unparseable metadata', () => {
      expect(readStoredOverrides(null)).toBeNull();
      expect(readStoredOverrides({})).toBeNull();
      expect(
        readStoredOverrides({ [DEPLOY_OVERRIDES_METADATA_KEY]: '{not json' }),
      ).toBeNull();
    });
  });

  describe('hasDeployOverrides', () => {
    it('ignores empty shells', () => {
      expect(hasDeployOverrides(null)).toBe(false);
      expect(hasDeployOverrides({})).toBe(false);
      expect(hasDeployOverrides({ domain: {} })).toBe(false);
      expect(hasDeployOverrides({ domain: { fqdn: undefined } })).toBe(false);
      expect(hasDeployOverrides({ domain: { tls: false } })).toBe(true);
      expect(hasDeployOverrides({ name: 'x' })).toBe(true);
    });
  });
});
