import {
  mostProvenRef,
  narrowCandidates,
  pinRunningTags,
  proofFilesFor,
  provableNames,
  provenTransforms,
  reconstructionReason,
  restoreProven,
  vouchedFiles,
} from './install-proof.util';
import { sha256 } from './manifest-eligibility.util';
import { ImageTagSlot } from './install-values.util';

const held = new Map([
  ['a.yaml', { sha: 'sa', carriesSecret: false, declaresProvenance: true }],
  ['00-secrets.yaml', { sha: 'ss', carriesSecret: true }],
  ['b.yaml', { sha: 'sb', carriesSecret: false }],
]);

const slot: ImageTagSlot = {
  variable: 'FLUI_API_IMAGE_TAG',
  kind: 'Deployment',
  name: 'flui-api',
  namespace: 'flui-system',
  container: 'api',
  repository: 'ghcr.io/flui-cloud/core',
};

describe('proving what a master holds', () => {
  it('never tries to prove a file that carries a Secret', () => {
    expect(provableNames(held)).toEqual(['a.yaml', 'b.yaml']);
  });

  it('keeps one candidate per distinct template, and copies common files raw', () => {
    const files = proofFilesFor(
      held,
      [
        [
          'r1',
          [
            { name: 'a.yaml', set: 'control', template: 'A' },
            { name: 'b.yaml', set: 'common', template: 'B' },
          ],
        ],
        ['r2', [{ name: 'a.yaml', set: 'control', template: 'A' }]],
      ] as never,
      null,
    );
    expect(files).toEqual([
      {
        name: 'a.yaml',
        templates: [{ ref: 'r1', template: 'A' }],
        masterSha: 'sa',
        raw: false,
      },
      {
        name: 'b.yaml',
        templates: [{ ref: 'r1', template: 'B' }],
        masterSha: 'sb',
        raw: true,
      },
    ]);
  });

  it('names the release that proved the most files', () => {
    expect(
      mostProvenRef({
        files: [
          { name: 'a', proven: true, ref: 'r1' },
          { name: 'b', proven: true, ref: 'r2' },
          { name: 'c', proven: true, ref: 'r2' },
          { name: 'd', proven: false, ref: 'r1' },
        ],
        values: {},
        unproven: {},
        ingressTlsFiles: [],
      }),
    ).toBe('r2');
  });

  it('tries the record, the running tag and every published tag first', () => {
    expect(
      narrowCandidates({
        recorded: { CLUSTER_ID: 'c-1', OIDC_SECRET: 's' },
        running: { FLUI_API_IMAGE_TAG: '2.0.0' },
        slots: [slot],
        images: ['ghcr.io/flui-cloud/core:1.9.0', 'other/image:3'],
        secretVariables: new Set(['OIDC_SECRET']),
      }),
    ).toEqual({
      CLUSTER_ID: ['c-1'],
      FLUI_API_IMAGE_TAG: ['2.0.0', '1.9.0', 'latest'],
    });
  });

  it('takes image tags from what runs, and leaves one unproven when it cannot be read', () => {
    expect(
      pinRunningTags(
        { values: { FLUI_API_IMAGE_TAG: 'old', X: '1' }, unproven: {} },
        [slot],
        { FLUI_API_IMAGE_TAG: 'new' },
      ),
    ).toEqual({ values: { FLUI_API_IMAGE_TAG: 'new', X: '1' }, unproven: {} });
    expect(
      pinRunningTags(
        { values: { FLUI_API_IMAGE_TAG: 'old' }, unproven: {} },
        [slot],
        {},
      ),
    ).toEqual({
      values: {},
      unproven: {
        FLUI_API_IMAGE_TAG:
          'the image this installation runs could not be read',
      },
    });
  });

  it('binds TLS on proven files and on recorded ones the master does not hold', () => {
    expect(
      provenTransforms(
        {
          raw: ['r.yaml'],
          ingressTls: { secretName: 't', files: ['a.yaml', 'gone.yaml'] },
        },
        ['b.yaml'],
        held,
      ),
    ).toEqual({
      raw: ['r.yaml'],
      ingressTls: { secretName: 't', files: ['b.yaml', 'gone.yaml'] },
    });
  });

  it('restores a body only when its rendering reproduces the digest', () => {
    const contents = new Map<string, string>();
    const pending = restoreProven(
      {
        files: [
          { name: 'a.yaml', proven: true, ref: 'r1', values: { V: '1' } },
          { name: 'b.yaml', proven: true, ref: 'r1', values: { V: '2' } },
        ],
        values: {},
        unproven: {},
        ingressTlsFiles: [],
      },
      [
        {
          name: 'a.yaml',
          templates: [{ ref: 'r1', template: 'v: ${V}\n' }],
          masterSha: sha256('v: 1\n'),
          raw: false,
        },
        {
          name: 'b.yaml',
          templates: [{ ref: 'r1', template: 'v: ${V}\n' }],
          masterSha: 'something else',
          raw: false,
        },
      ],
      { secretName: 't' },
      contents,
    );
    expect([...contents]).toEqual([['a.yaml', 'v: 1\n']]);
    expect(pending.map((p) => p.name)).toEqual(['b.yaml']);
    expect(vouchedFiles(held, contents)).toEqual(
      new Map([
        ['a.yaml', { sha: 'sa', carriesSecret: false, content: 'v: 1\n' }],
        ['00-secrets.yaml', { sha: 'ss', carriesSecret: true }],
        [
          'b.yaml',
          {
            sha: 'sb',
            carriesSecret: false,
            withheld: true,
            declaresProvenance: false,
          },
        ],
      ]),
    );
  });

  it('writes nothing over a record, and nothing when nothing is proven', () => {
    expect(reconstructionReason({ source: 'installer' } as never, 3)).toMatch(
      /written by the installer/,
    );
    expect(reconstructionReason(null, 0)).toMatch(/nothing is proven/);
    expect(reconstructionReason(null, 2)).toBeUndefined();
  });
});
