import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import { PIRAEUS_IMAGE_DIGESTS, pinnedPiraeusManifest } from './piraeus-images';

const imageConfig = [
  '---',
  'base: quay.io/piraeusdatastore',
  'components:',
  '  linstor-satellite:',
  '    tag: v1.35.2',
  '    image: piraeus-server',
  '  drbd-module-loader:',
  '    tag: v9.3.4',
  '    image: drbd9-resolute',
  '    match:',
  '      - osImage: Ubuntu 24\\.04',
  '        image: drbd9-noble',
].join('\n');

const manifest = [
  yaml.dump({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'piraeus-operator-image-config' },
    data: { '0_piraeus_datastore_images.yaml': imageConfig },
  }),
  yaml.dump({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'piraeus-operator-controller-manager' },
    spec: {
      template: {
        spec: {
          containers: [
            { image: 'quay.io/piraeusdatastore/piraeus-operator:v2.12.0' },
          ],
        },
      },
    },
  }),
].join('---\n');
const sha = createHash('sha256').update(manifest).digest('hex');

describe('the volume engine pinned by digest', () => {
  it('refuses a manifest that is not the one checked', () => {
    expect(() => pinnedPiraeusManifest(manifest)).toThrow(
      'is not the one Flui checked',
    );
  });

  it('fixes every image of the image config, by operating system too, and the operator itself', () => {
    const docs = yaml.loadAll(pinnedPiraeusManifest(manifest, sha)) as any[];
    const config = yaml.load(
      docs[0].data['0_piraeus_datastore_images.yaml'],
    ) as any;

    expect(config.components['linstor-satellite'].digest).toBe(
      PIRAEUS_IMAGE_DIGESTS['quay.io/piraeusdatastore/piraeus-server:v1.35.2'],
    );
    expect(config.components['drbd-module-loader'].digest).toBe(
      PIRAEUS_IMAGE_DIGESTS['quay.io/piraeusdatastore/drbd9-resolute:v9.3.4'],
    );
    expect(config.components['drbd-module-loader'].match[0].digest).toBe(
      PIRAEUS_IMAGE_DIGESTS['quay.io/piraeusdatastore/drbd9-noble:v9.3.4'],
    );
    expect(docs[1].spec.template.spec.containers[0].image).toBe(
      `quay.io/piraeusdatastore/piraeus-operator:v2.12.0@${PIRAEUS_IMAGE_DIGESTS['quay.io/piraeusdatastore/piraeus-operator:v2.12.0']}`,
    );
  });

  it('refuses an image it has no digest for, rather than running it by tag', () => {
    const other = manifest.replace('v1.35.2', 'v1.99.0');
    expect(() =>
      pinnedPiraeusManifest(
        other,
        createHash('sha256').update(other).digest('hex'),
      ),
    ).toThrow(
      'No pinned digest for quay.io/piraeusdatastore/piraeus-server:v1.99.0',
    );
  });
});
