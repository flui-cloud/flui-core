jest.mock('@kubernetes/client-node', () => ({}));

import { DeclaredImageService } from './declared-image.service';
import { HeldFile } from './manifest-master.service';

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
