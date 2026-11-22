jest.mock('@kubernetes/client-node', () => ({}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { CatalogInstallerService } from './catalog-installer.service';

function installerFor(seed: string) {
  const manifest = load(
    readFileSync(join(__dirname, '..', 'seed', `${seed}.flui.yaml`), 'utf8'),
  ) as { spec: { type: string } };
  const definition = {
    slug: seed,
    appType: manifest.spec.type,
    manifest,
  };
  return new CatalogInstallerService(
    {} as never,
    { findPublishedBySlug: async () => definition } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('the inputs an install form asks for, checked by the API', () => {
  it('refuses a composed app whose admin password is missing', async () => {
    await expect(
      installerFor('zitadel').preflight('zitadel', {
        clusterId: 'c1',
        userInputs: {
          ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME: 'admin@example.com',
        },
      } as never),
    ).rejects.toThrow(
      'Admin password (ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD): required',
    );
  });

  it('refuses a composed app whose password breaks its own rule', async () => {
    await expect(
      installerFor('glitchtip').preflight('glitchtip', {
        clusterId: 'c1',
        userInputs: {
          DJANGO_SUPERUSER_EMAIL: 'admin@example.com',
          DJANGO_SUPERUSER_PASSWORD: 'short',
        },
      } as never),
    ).rejects.toThrow('must be at least 10 characters');
  });

  it('accepts a composed app whose inputs are all there and well formed', async () => {
    await expect(
      installerFor('glitchtip').preflight('glitchtip', {
        clusterId: 'c1',
        userInputs: {
          DJANGO_SUPERUSER_EMAIL: 'admin@example.com',
          DJANGO_SUPERUSER_PASSWORD: 'long-enough-1',
        },
      } as never),
    ).resolves.toBeUndefined();
  });
});
