import { createHash } from 'node:crypto';
import { CNPG_OPERATOR_IMAGE_DIGEST, pinnedCnpgManifest } from './cnpg-images';

describe('the Postgres HA operator pinned by digest', () => {
  const manifest = [
    '        - name: OPERATOR_IMAGE_NAME',
    '          value: ghcr.io/cloudnative-pg/cloudnative-pg:1.30.1',
    '        image: ghcr.io/cloudnative-pg/cloudnative-pg:1.30.1',
  ].join('\n');
  const sha = createHash('sha256').update(manifest).digest('hex');

  it('refuses a manifest that is not the one checked', () => {
    expect(() => pinnedCnpgManifest(manifest)).toThrow(
      'is not the one Flui checked',
    );
  });

  it('fixes the operator, and the image it hands to the instances it starts', () => {
    const pinned = pinnedCnpgManifest(manifest, sha);
    expect(
      pinned.split(
        `ghcr.io/cloudnative-pg/cloudnative-pg:1.30.1@${CNPG_OPERATOR_IMAGE_DIGEST}`,
      ),
    ).toHaveLength(3);
  });
});
