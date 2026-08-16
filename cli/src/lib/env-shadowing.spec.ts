import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findShadowedKeys } from './env-shadowing';

/**
 * `flui env export-config` writes `.env`; `flui dev creds` writes `.env.local`;
 * the API loads the second one first. When the two disagree the export reports
 * success and changes nothing the API reads — that is how a provider URL for a
 * decommissioned instance survived several correct exports.
 */
describe('findShadowedKeys', () => {
  let dir: string;
  const localPath = () => path.join(dir, '.env.local');
  const writeLocal = (content: string) =>
    fs.writeFileSync(localPath(), content, 'utf-8');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flui-env-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds nothing when the other file does not exist', () => {
    expect(findShadowedKeys(localPath(), ['OIDC_ISSUER'])).toEqual([]);
  });

  it('finds nothing when the two files do not overlap', () => {
    writeLocal('DB_PASSWORD=secret\nJWT_SECRET=other\n');
    expect(findShadowedKeys(localPath(), ['OIDC_ISSUER'])).toEqual([]);
  });

  it('names every key the other file will win', () => {
    writeLocal('DB_PASSWORD=x\nOIDC_ISSUER=https://dead\nOIDC_AUDIENCE=1234\n');
    expect(
      findShadowedKeys(localPath(), [
        'OIDC_ISSUER',
        'OIDC_AUDIENCE',
        'PUBLIC_WEB_URL',
      ]),
    ).toEqual(['OIDC_ISSUER', 'OIDC_AUDIENCE']);
  });

  it('does not read a commented-out line as a definition', () => {
    writeLocal('# OIDC_ISSUER=https://commented\nDB_PASSWORD=x\n');
    expect(findShadowedKeys(localPath(), ['OIDC_ISSUER'])).toEqual([]);
  });

  it('does not match a key that only appears inside a value', () => {
    writeLocal('SOME_URL=https://x/?k=OIDC_ISSUER\n');
    expect(findShadowedKeys(localPath(), ['OIDC_ISSUER'])).toEqual([]);
  });

  it('tolerates whitespace and an export prefix', () => {
    writeLocal('  export OIDC_ISSUER = https://dead\n');
    expect(findShadowedKeys(localPath(), ['OIDC_ISSUER'])).toEqual([
      'OIDC_ISSUER',
    ]);
  });

  it('ignores blank lines and lines with no assignment', () => {
    writeLocal('\n   \njust-a-word\nDB_PASSWORD=x\n');
    expect(findShadowedKeys(localPath(), ['OIDC_ISSUER'])).toEqual([]);
  });

  it('catches a provider admin URL left pointing at a dead installation', () => {
    writeLocal(
      'OIDC_PROVIDER_ADMIN_URL=https://auth.example.192-0-2-1.nip.io\n',
    );
    expect(findShadowedKeys(localPath(), ['OIDC_PROVIDER_ADMIN_URL'])).toEqual([
      'OIDC_PROVIDER_ADMIN_URL',
    ]);
  });
});
