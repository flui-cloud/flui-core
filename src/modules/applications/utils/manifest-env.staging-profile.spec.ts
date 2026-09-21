import { readFileSync } from 'node:fs';
import { parseYaml } from '@flui-cloud/spec';
import type { ApplicationManifest } from '@flui-cloud/spec';
import {
  applyEnvironmentProfile,
  normalizeManifestEnv,
} from './manifest-env.util';

/**
 * The `environments:` block against the manifests that will actually use it.
 *
 * The unit tests cover the function; this covers the two files staging is about
 * to be deployed from, which is where a typo in a branch name or an override
 * that silently does nothing would otherwise be found — on a cluster.
 *
 * Skipped when those repositories are not beside this one, so the suite stays
 * green on a machine that only checked this one out.
 */
const SIBLINGS = {
  'flui.landing': '../flui.landing/flui.yaml',
  'flui-managed': '../flui-managed/flui.yaml',
} as const;

const read = (path: string): ApplicationManifest | null => {
  try {
    return parseYaml(readFileSync(path, 'utf8')) as ApplicationManifest;
  } catch {
    return null;
  }
};

const valueOf = (
  manifest: ApplicationManifest,
  name: string,
): string | undefined =>
  normalizeManifestEnv(manifest.deploy.env).find((e) => e.name === name)?.value;

describe('the staging profile of the apps that declare one', () => {
  for (const [app, path] of Object.entries(SIBLINGS)) {
    const base = read(path);

    describe(app, () => {
      it('declares production at the base, so an unprofiled deploy is the real one', () => {
        if (!base) return;
        const key =
          app === 'flui.landing'
            ? 'PUBLIC_FLUI_ENVIRONMENT'
            : 'FLUI_ENVIRONMENT';
        expect(valueOf(base, key)).toBe('production');
      });

      it('overlays staging for a push on the branch it names', () => {
        if (!base) return;
        const key =
          app === 'flui.landing'
            ? 'PUBLIC_FLUI_ENVIRONMENT'
            : 'FLUI_ENVIRONMENT';
        const staged = applyEnvironmentProfile(base, 'staging');
        expect(valueOf(staged, key)).toBe('staging');
      });

      /**
       * The binding is a branch name, and a branch name is a string somebody
       * typed. A profile bound to a branch nobody pushes is a profile that
       * never runs, and nothing else would say so.
       */
      it('leaves the base alone for any other branch', () => {
        if (!base) return;
        const key =
          app === 'flui.landing'
            ? 'PUBLIC_FLUI_ENVIRONMENT'
            : 'FLUI_ENVIRONMENT';
        for (const branch of ['main', 'stage', 'Staging', '']) {
          expect(valueOf(applyEnvironmentProfile(base, branch), key)).toBe(
            'production',
          );
        }
      });

      it('never lets a profile move the build', () => {
        if (!base) return;
        const staged = applyEnvironmentProfile(base, 'staging');
        expect(staged.build).toEqual(base.build);
      });
    });
  }
});
