jest.mock('@kubernetes/client-node', () => ({}));

import { DeclaredImageService } from './declared-image.service';
import { HeldFile } from './manifest-master.service';
import { InstallValuesService } from './install-values.service';
import { sha256 } from '../utils/manifest-eligibility.util';

const API = (tag: string) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: flui-api
spec:
  template:
    spec:
      containers:
      - name: flui-api
        image: ghcr.io/flui-cloud/core:${tag}
`;

function build(files: Map<string, HeldFile>, templates = new Map()) {
  const written: Array<{ name: string; content: string }> = [];
  const master = {
    write: jest.fn(async (_kc: string, _n: string, _p: string, f: any[]) => {
      written.push(...f);
      return f.map((x) => x.name);
    }),
  };
  const installValues = {
    controlMaster: jest.fn(async () => ({
      kubeconfig: 'kc',
      node: 'master-0',
    })),
    readProven: jest.fn(async () => ({
      files,
      templates,
      mayHoldSecret: new Set<string>(),
    })),
  };
  const service = new DeclaredImageService(
    {} as never,
    {} as never,
    {} as never,
    master as never,
    installValues as never,
  );
  return { service, master, written, installValues };
}

describe('DeclaredImageService', () => {
  it('rewrites the tag in a file whose copy was proven, and never reads the master itself', async () => {
    const { service, written, installValues } = build(
      new Map([
        [
          '09-flui-api.yaml',
          { sha: 's', carriesSecret: false, content: API('1.0.0') },
        ],
      ]),
    );
    const result = await service.pin('ghcr.io/flui-cloud/core:2.0.0', {
      images: ['ghcr.io/flui-cloud/core:1.0.0'],
    });
    expect(result).toMatchObject({ pinned: true, outcome: 'written' });
    expect(written[0].content).toContain('ghcr.io/flui-cloud/core:2.0.0');
    expect(installValues.readProven).toHaveBeenCalledWith(expect.anything(), {
      images: [
        'ghcr.io/flui-cloud/core:2.0.0',
        'ghcr.io/flui-cloud/core:1.0.0',
      ],
    });
  });

  it('refuses when a file that may declare the image could not be proven', async () => {
    const { service, master } = build(
      new Map([
        [
          '09-flui-api.yaml',
          { sha: 's', carriesSecret: false, withheld: true },
        ],
      ]),
      new Map([['09-flui-api.yaml', [API('${FLUI_API_IMAGE_TAG}')]]]),
    );
    const result = await service.pin('ghcr.io/flui-cloud/core:2.0.0');
    expect(result.pinned).toBe(false);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toContain('09-flui-api.yaml');
    expect(master.write).not.toHaveBeenCalled();
  });

  it('checks without writing', async () => {
    const stale = build(
      new Map([
        [
          '09-flui-api.yaml',
          { sha: 's', carriesSecret: false, content: API('1.0.0') },
        ],
      ]),
    );
    const checked = await stale.service.check('ghcr.io/flui-cloud/core:2.0.0');
    expect(checked.pinned).toBe(false);
    expect(stale.master.write).not.toHaveBeenCalled();

    const current = build(
      new Map([
        [
          '09-flui-api.yaml',
          { sha: 's', carriesSecret: false, content: API('2.0.0') },
        ],
      ]),
    );
    await expect(
      current.service.check('ghcr.io/flui-cloud/core:2.0.0'),
    ).resolves.toMatchObject({ pinned: true, outcome: 'already' });
  });
});

describe('DeclaredImageService over a master that declares an unpublished build', () => {
  const TEMPLATE = API('${FLUI_API_IMAGE_TAG}');
  const DEV = 'ghcr.io/flui-cloud/core:25eeb87';
  const RELEASED = 'ghcr.io/flui-cloud/core:0.13.0-rc.14';

  function onMaster(declares?: string[]) {
    const written: Array<{ name: string; content: string }> = [];
    const master = {
      read: jest.fn(
        async () =>
          new Map<string, HeldFile>([
            [
              '09-flui-api.yaml',
              {
                sha: sha256(API('25eeb87')),
                carriesSecret: false,
                withheld: true,
                declaresProvenance: true,
                ...(declares ? { images: declares } : {}),
              },
            ],
          ]),
      ),
      write: jest.fn(async (_kc: string, _n: string, _p: string, f: any[]) => {
        written.push(...f);
        return f.map((x) => x.name);
      }),
    };
    const state = {
      recorded: jest.fn(async () => null),
      runningTags: jest.fn(async () => ({
        FLUI_API_IMAGE_TAG: '0.13.0-rc.14',
      })),
      candidates: jest.fn(async () => ({})),
    };
    const sources = {
      candidateRefs: jest.fn(async () => ['ref-1']),
      firstSecretIndex: jest.fn(async () => new Map()),
      templatesByRef: jest.fn(async () => [
        [
          'ref-1',
          [{ name: '09-flui-api.yaml', set: 'control', template: TEMPLATE }],
        ],
      ]),
      publishedImages: jest.fn(async () => [RELEASED]),
    };
    const masters = {
      controlMaster: jest.fn(async () => ({
        kubeconfig: 'kc',
        node: 'master-0',
        cluster: { id: 'c-1' },
        kind: 'control',
      })),
    };
    const installValues = new InstallValuesService(
      masters as never,
      state as never,
      sources as never,
      master as never,
    );
    const service = new DeclaredImageService(
      {} as never,
      {} as never,
      {} as never,
      master as never,
      installValues,
    );
    return { service, master, written };
  }

  it('reads the copy through the tag the file declares and reports the drift', async () => {
    const { service, master } = onMaster([DEV]);
    const result = await service.check(RELEASED);
    expect(result).toMatchObject({
      pinned: false,
      outcome: 'failed',
      files: ['09-flui-api.yaml'],
      reason: '09-flui-api.yaml still declare another tag',
    });
    expect(master.write).not.toHaveBeenCalled();
  });

  it('moves the file to the running release', async () => {
    const { service, written } = onMaster([DEV]);
    const result = await service.pin(RELEASED);
    expect(result).toMatchObject({ pinned: true, outcome: 'written' });
    expect(written).toEqual([
      {
        name: '09-flui-api.yaml',
        content: API('0.13.0-rc.14'),
        expectCurrentSha: sha256(API('25eeb87')),
      },
    ]);
  });

  it('still refuses when the master did not say what the file declares', async () => {
    const { service, master } = onMaster();
    const result = await service.pin(RELEASED);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toContain('no published release reproduces');
    expect(master.write).not.toHaveBeenCalled();
  });
});
