import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';

/** The SHA-256 of the v2.12.0 release manifest: a manifest that differs is refused. */
export const PIRAEUS_MANIFEST_SHA256 =
  '1d3b8f6cee38a369acda013e126f896f1e2b29c1f86c1539e66ccd475868a161';

/**
 * Every image that manifest runs, by the digest its registry served on
 * 8 November 2026. A tag can be moved to other content; a digest cannot, and
 * the DRBD module these images build goes into the host's kernel.
 */
export const PIRAEUS_IMAGE_DIGESTS: Record<string, string> = {
  'quay.io/piraeusdatastore/drbd-reactor:v1.12.0':
    'sha256:a3d7a83f2eac5c5e8cd366f341b3c79cd6d0f2a3b4fcef9890e3b16140ce91ab',
  'quay.io/piraeusdatastore/drbd-shutdown-guard:v1.1.2':
    'sha256:a4adba73d07f6ba2605d0594676df47ab143e004991caadea3b7b556ead2db6e',
  'quay.io/piraeusdatastore/drbd9-almalinux10:v9.3.4':
    'sha256:4bd5a2a8c7309a3578d5f9d4385ecc4471b9ac5e4c3f209cece8a8cef1bcdfba',
  'quay.io/piraeusdatastore/drbd9-almalinux8:v9.3.4':
    'sha256:6954910569cf701adde2cf7f97d007b48ffaaea15cfa8fb4c5634086829007a3',
  'quay.io/piraeusdatastore/drbd9-almalinux9:v9.3.4':
    'sha256:e0a3ada199c28ff3d7f5ba5720a940a1b68764c05567103061c8c0d460160723',
  'quay.io/piraeusdatastore/drbd9-bookworm:v9.3.4':
    'sha256:fb35c74d0ad24b070131346c3ab1ca706c06bc691778d71591d4537dbb18b393',
  'quay.io/piraeusdatastore/drbd9-bullseye:v9.3.4':
    'sha256:4aa5011acefce274837910bb476e56de3572115f6d1ed1e728dc4abd5746751d',
  'quay.io/piraeusdatastore/drbd9-jammy:v9.3.4':
    'sha256:e58cc9342d45c0d629a10106b5f2e3ae6c1468fc5ebbe1c74be858c56ef18bb8',
  'quay.io/piraeusdatastore/drbd9-noble:v9.3.4':
    'sha256:34ce597f6107363035528ffe498be4c8c892fbdaaef93d558cfd9e8ec37cc83d',
  'quay.io/piraeusdatastore/drbd9-resolute:v9.3.4':
    'sha256:c2158adc51daa95688e5e37e3c50418d157af2c10abc0e8c78b559f485108fec',
  'quay.io/piraeusdatastore/drbd9-trixie:v9.3.4':
    'sha256:fc4abdb9f46455b765c841500d8f98fa0bbf71b3e391cab58764510ca5be9b94',
  'quay.io/piraeusdatastore/ktls-utils:v1.2.1':
    'sha256:d9ce9e1b31c4a19986abc9d5ce375dc4e407a198b28dd05e48ce18d647d3f968',
  'quay.io/piraeusdatastore/linstor-affinity-controller:v1.5.0':
    'sha256:27797e5c97d42d7b75af7a45877c6840cdc1be8c6e6d1624dc4a1a46aa79ecbf',
  'quay.io/piraeusdatastore/piraeus-csi-nfs-server:v1.13.1':
    'sha256:b9d91188e435fc9b2ddd8f2b9fba3147102faa08bcafcaba2d14d6df56f8e153',
  'quay.io/piraeusdatastore/piraeus-csi:v1.13.1':
    'sha256:900a9d34b8d2c4ed6479d1c0480b18aa5c003678532a12de71de54464b42d05e',
  'quay.io/piraeusdatastore/piraeus-ha-controller:v1.3.4':
    'sha256:ac13aebcbc161792373e181234d9660bbb54ac5425024d5d871992a7eb448b65',
  'quay.io/piraeusdatastore/piraeus-operator:v2.12.0':
    'sha256:2fee47e187c1c0f53335d888ffb151fbf1d02868fe8b9fdc18d32629c48cdf49',
  'quay.io/piraeusdatastore/piraeus-server:v1.35.2':
    'sha256:d8da06ae50c0fa9c36f2649a8073667b546d6e9dcacc123c203d3d47ab5bc0f0',
  'registry.k8s.io/sig-storage/csi-attacher:v4.13.0':
    'sha256:d1a26170efed45491074ca4545c81844eee2b9043fb885ac01fb4aed6f8b72d2',
  'registry.k8s.io/sig-storage/csi-node-driver-registrar:v2.18.0':
    'sha256:b7fefd08651f00ac4df1a196ed4c621c2451fbb899297fe9fad9e36c667af0c0',
  'registry.k8s.io/sig-storage/csi-provisioner:v6.3.0':
    'sha256:a4b0b1a37605b7b04a293e136edf7006ec1786a8eb3f4e5a945f81d667dcc371',
  'registry.k8s.io/sig-storage/csi-resizer:v2.2.1':
    'sha256:ea1d25e23479000c7e8eeb92d827df66258df4e482ca054c5e7ce3fc0f5c41a5',
  'registry.k8s.io/sig-storage/csi-snapshotter:v8.6.0':
    'sha256:42af0929bcd60a43499825c078a60ff0534e08af8fbeb283aa391be40feb9f3e',
  'registry.k8s.io/sig-storage/livenessprobe:v2.20.0':
    'sha256:19f2cf2f40e1987c7943945deca5f65cd4e4bf5cc0657fc78a5df131861578e8',
};

interface ImageConfig {
  base: string;
  components: Record<
    string,
    {
      tag: string;
      image: string;
      digest?: string;
      match?: Array<{ image: string; digest?: string }>;
    }
  >;
}

function digestOf(ref: string): string {
  const digest = PIRAEUS_IMAGE_DIGESTS[ref];
  if (!digest) throw new Error(`No pinned digest for ${ref}`);
  return digest;
}

function pinImageConfig(text: string): string {
  const config = yaml.load(text) as ImageConfig;
  for (const component of Object.values(config.components ?? {})) {
    const ref = (image: string) => `${config.base}/${image}:${component.tag}`;
    component.digest = digestOf(ref(component.image));
    for (const match of component.match ?? []) {
      match.digest = digestOf(ref(match.image));
    }
  }
  return yaml.dump(config, { lineWidth: -1 });
}

function pinContainers(
  containers: Array<{ image?: string }> | undefined,
): void {
  for (const c of containers ?? []) {
    if (c.image && !c.image.includes('@')) {
      c.image = `${c.image}@${digestOf(c.image)}`;
    }
  }
}

/**
 * The release manifest with every image fixed by digest, after checking it is
 * the manifest these digests were read for.
 */
export function pinnedPiraeusManifest(
  manifest: string,
  expectedSha256 = PIRAEUS_MANIFEST_SHA256,
): string {
  const sha = createHash('sha256').update(manifest).digest('hex');
  if (sha !== expectedSha256) {
    throw new Error(
      `The volume engine's manifest is not the one Flui checked (SHA-256 ${sha}): refusing to install it`,
    );
  }
  const docs = yaml.loadAll(manifest).filter(Boolean) as Array<
    Record<string, any>
  >;
  for (const doc of docs) {
    if (
      doc.kind === 'ConfigMap' &&
      doc.metadata?.name === 'piraeus-operator-image-config'
    ) {
      for (const key of Object.keys(doc.data ?? {})) {
        doc.data[key] = pinImageConfig(doc.data[key]);
      }
    }
    if (doc.kind === 'Deployment') {
      pinContainers(doc.spec?.template?.spec?.containers);
      pinContainers(doc.spec?.template?.spec?.initContainers);
    }
  }
  return docs.map((d) => yaml.dump(d, { lineWidth: -1 })).join('---\n');
}
