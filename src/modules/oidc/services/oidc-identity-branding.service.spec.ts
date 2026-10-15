jest.mock('@kubernetes/client-node', () => ({}));

import * as fs from 'node:fs';
import * as path from 'node:path';
import { OidcIdentityBranding } from './oidc-identity-branding.service';

const ASSETS = path.resolve(__dirname, '../../../assets/branding');

function build(
  overrides: Record<string, jest.Mock> = {},
  textsApply?: jest.Mock,
) {
  const calls: string[] = [];
  const provider = {
    getOrgMetadata: jest.fn(async () => null),
    upsertCustomLabelPolicy: jest.fn(async () => void calls.push('policy')),
    uploadBrandingAsset: jest.fn(
      async (_p: string, _h: string, kind: string) => void calls.push(kind),
    ),
    activateLabelPolicy: jest.fn(async () => void calls.push('activate')),
    setOrgMetadata: jest.fn(async () => void calls.push('version')),
    ...overrides,
  };
  const config = { get: jest.fn(() => undefined) };
  const loginTexts = {
    apply:
      textsApply ??
      jest.fn(async () => {
        calls.push('texts');
        return { languages: 2, updated: [], failed: [] };
      }),
  };
  const branding = new OidcIdentityBranding(
    provider as never,
    loginTexts as never,
    config as never,
    { findOne: jest.fn(async () => null) } as never,
  );
  return { branding, provider, loginTexts, calls };
}

const conn = { pat: 'pat', hostHeader: 'auth.example.com' };

describe('identity provider branding', () => {
  it('ships every asset it uploads, logos included', () => {
    for (const file of [
      'logo-light.png',
      'logo-dark.png',
      'icon-light.png',
      'icon-dark.png',
    ]) {
      const bytes = fs.readFileSync(path.join(ASSETS, file));
      expect(bytes.subarray(1, 4).toString()).toBe('PNG');
      expect(bytes.length).toBeLessThan(512 * 1024);
    }
  });

  it('writes the label policy before any asset and activates last, then records the version', async () => {
    const { branding, calls } = build();
    await expect(branding.ensureBranding(false, conn)).resolves.toBe(true);
    expect(calls).toEqual([
      'policy',
      'logo-light',
      'logo-dark',
      'icon-light',
      'icon-dark',
      'activate',
      'texts',
      'version',
    ]);
  });

  it('matches the dashboard theme, hides the watermark and the login name suffix', async () => {
    const { branding, provider } = build();
    await branding.ensureBranding(true, conn);
    expect(provider.upsertCustomLabelPolicy).toHaveBeenCalledWith(
      'pat',
      'auth.example.com',
      expect.objectContaining({
        primaryColor: '#225AF1',
        primaryColorDark: '#3369FF',
        backgroundColorDark: '#080B11',
        disableWatermark: true,
        hideLoginNameSuffix: true,
      }),
    );
  });

  it('does not record the version when a step failed, so the next start retries', async () => {
    const { branding, provider, calls } = build({
      uploadBrandingAsset: jest.fn(async () => {
        throw new Error('Request failed with status code 404');
      }),
    });
    await expect(branding.ensureBranding(false, conn)).resolves.toBe(false);
    expect(provider.setOrgMetadata).not.toHaveBeenCalled();
    expect(calls).toEqual(['policy', 'activate', 'texts']);
  });

  it('does not record the version when the sign-in texts could not be set', async () => {
    const { branding, provider } = build(
      {},
      jest.fn(async () => {
        throw new Error('2 text group(s) not set');
      }),
    );
    await expect(branding.ensureBranding(false, conn)).resolves.toBe(false);
    expect(provider.setOrgMetadata).not.toHaveBeenCalled();
  });

  it('uploads nothing when the policy itself could not be written', async () => {
    const { branding, provider } = build({
      upsertCustomLabelPolicy: jest.fn(async () => {
        throw new Error('down');
      }),
    });
    await expect(branding.ensureBranding(false, conn)).resolves.toBe(false);
    expect(provider.uploadBrandingAsset).not.toHaveBeenCalled();
  });

  it('skips when the stored version matches, and re-applies when it does not', async () => {
    const first = build();
    await first.branding.ensureBranding(false, conn);
    const version = (
      first.provider.setOrgMetadata.mock.calls[0] as unknown[]
    )[3];

    const same = build({ getOrgMetadata: jest.fn(async () => version) });
    await expect(same.branding.ensureBranding(false, conn)).resolves.toBe(
      false,
    );
    expect(same.provider.upsertCustomLabelPolicy).not.toHaveBeenCalled();

    const stale = build({ getOrgMetadata: jest.fn(async () => 'old') });
    await expect(stale.branding.ensureBranding(false, conn)).resolves.toBe(
      true,
    );
  });

  it('talks to the provider on the issuer domain when no connection is given', async () => {
    const before = {
      pat: process.env.ZITADEL_SERVICE_ACCOUNT_PAT,
      issuer: process.env.OIDC_ISSUER,
    };
    process.env.ZITADEL_SERVICE_ACCOUNT_PAT = 'pat-env';
    process.env.OIDC_ISSUER = 'https://auth.gojo.example/';
    try {
      const { branding, provider } = build();
      await branding.ensureBranding(true);
      expect(provider.upsertCustomLabelPolicy).toHaveBeenCalledWith(
        'pat-env',
        'auth.gojo.example',
        expect.anything(),
      );
    } finally {
      process.env.ZITADEL_SERVICE_ACCOUNT_PAT = before.pat;
      process.env.OIDC_ISSUER = before.issuer;
    }
  });
});
