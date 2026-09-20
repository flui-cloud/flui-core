import {
  bareRepository,
  hasSettled,
  pinImageIn,
  splitImageRef,
} from './declared-image.util';

/**
 * The declared tag, and the four ways rewriting it could lie.
 *
 * The defect this closes was measured on a live installation: an in-app update
 * moved the Deployment and not the file k3s re-applies, so the first restart put
 * the old build back. A fix that reports success without writing anything would
 * be the same silence with extra steps, so most of what follows is about that.
 */
describe('pinning the image a manifest declares', () => {
  const manifest = (image: string) =>
    [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'spec:',
      '  template:',
      '    spec:',
      '      initContainers:',
      '      - name: wait-for-db',
      '        image: busybox:1.36',
      '      containers:',
      '      - name: flui-api',
      `        image: ${image}`,
      '',
    ].join('\n');

  it('moves the tag and leaves every other image alone', () => {
    const out = pinImageIn(
      manifest('ghcr.io/flui-cloud/core:0.13.0-rc.1'),
      'ghcr.io/flui-cloud/core:0.13.0-rc.8',
    );

    expect(out.changed).toBe(true);
    expect(out.content).toContain('image: ghcr.io/flui-cloud/core:0.13.0-rc.8');
    expect(out.content).toContain('image: busybox:1.36');
  });

  it('is a line edit, so nothing else in the file moves', () => {
    const before = manifest('ghcr.io/flui-cloud/core:0.13.0-rc.1');
    const after = pinImageIn(
      before,
      'ghcr.io/flui-cloud/core:0.13.0-rc.8',
    ).content;

    const differing = before
      .split('\n')
      .filter((line, i) => line !== after.split('\n')[i]);
    expect(differing).toEqual([
      '        image: ghcr.io/flui-cloud/core:0.13.0-rc.1',
    ]);
  });

  /**
   * The running Deployment names whatever registry the cluster pulls from, and
   * the file may name another. Comparing the whole string made a pin on a mirror
   * match nothing and report success.
   */
  it('matches a mirrored registry, and writes the mirror back', () => {
    const out = pinImageIn(
      manifest('registry.internal.example:5000/flui-cloud/core:0.13.0-rc.1'),
      'ghcr.io/flui-cloud/core:0.13.0-rc.8',
    );

    expect(out.changed).toBe(true);
    expect(out.content).toContain(
      'image: registry.internal.example:5000/flui-cloud/core:0.13.0-rc.8',
    );
    expect(out.content).not.toContain('ghcr.io');
  });

  /**
   * Filling a placeholder in for the first time is rendering, and rendering a
   * master's rendered copy is what this whole module refuses to do.
   */
  it('refuses a file that was never rendered instead of rendering it', () => {
    const out = pinImageIn(
      manifest('ghcr.io/flui-cloud/core:${FLUI_API_IMAGE_TAG}'),
      'ghcr.io/flui-cloud/core:0.13.0-rc.8',
    );

    expect(out.changed).toBe(false);
    expect(out.refusal).toMatch(/never rendered/);
    expect(out.content).toContain('${FLUI_API_IMAGE_TAG}');
  });

  it('says a file declares nothing of ours rather than reporting success', () => {
    const out = pinImageIn(
      manifest('postgres:15-alpine'),
      'ghcr.io/flui-cloud/core:0.13.0-rc.8',
    );

    expect(out.declared).toBe(false);
    expect(out.changed).toBe(false);
  });

  it('counts a file already naming the tag as declared, and writes nothing', () => {
    const out = pinImageIn(
      manifest('ghcr.io/flui-cloud/core:0.13.0-rc.8'),
      'ghcr.io/flui-cloud/core:0.13.0-rc.8',
    );

    expect(out.declared).toBe(true);
    expect(out.changed).toBe(false);
  });

  it('keeps a quoted value quoted and a trailing comment attached', () => {
    const out = pinImageIn(
      '        image: "ghcr.io/flui-cloud/core:0.13.0-rc.1" # pinned at install',
      'ghcr.io/flui-cloud/core:0.13.0-rc.8',
    );

    expect(out.content).toBe(
      '        image: "ghcr.io/flui-cloud/core:0.13.0-rc.8" # pinned at install',
    );
  });

  it('declines a reference with no tag to write', () => {
    const out = pinImageIn(
      manifest('ghcr.io/flui-cloud/core:1'),
      'ghcr.io/flui-cloud/core',
    );

    expect(out.changed).toBe(false);
    expect(out.refusal).toMatch(/no tag/);
  });
});

describe('reading an image reference', () => {
  it('does not read a registry port as a tag', () => {
    expect(splitImageRef('registry.example:5000/flui-cloud/core')).toBeNull();
    expect(splitImageRef('registry.example:5000/flui-cloud/core:1.2')).toEqual({
      repository: 'registry.example:5000/flui-cloud/core',
      tag: '1.2',
    });
  });

  it('ignores a digest, which is not what a release moves', () => {
    expect(splitImageRef('ghcr.io/flui-cloud/core:1.2@sha256:abc')).toEqual({
      repository: 'ghcr.io/flui-cloud/core',
      tag: '1.2',
    });
  });

  it('strips a registry host and only a registry host', () => {
    expect(bareRepository('ghcr.io/flui-cloud/core')).toBe('flui-cloud/core');
    expect(bareRepository('localhost:5000/flui-cloud/core')).toBe(
      'flui-cloud/core',
    );
    // No dot, no colon: an organisation, not a host. Stripping it would make
    // `flui-cloud/core` and `someone-else/core` the same repository.
    expect(bareRepository('flui-cloud/core')).toBe('flui-cloud/core');
  });
});

/**
 * The guard that keeps the repair from being worse than the defect. Today a
 * rollout that cannot come up is undone by the next restart, because the file
 * still names the last build that worked. Declaring a tag before it is running
 * would turn that restart from the cure into the thing that redoes the damage.
 */
describe('deciding a rollout has arrived', () => {
  const deployment = (over: Record<string, unknown> = {}) => ({
    metadata: { generation: 4 },
    spec: { replicas: 1 },
    status: {
      observedGeneration: 4,
      updatedReplicas: 1,
      readyReplicas: 1,
      availableReplicas: 1,
      ...over,
    },
  });

  it('accepts a Deployment fully on its current generation', () => {
    expect(hasSettled(deployment())).toBe(true);
  });

  it('refuses one the controller has not observed yet', () => {
    expect(hasSettled(deployment({ observedGeneration: 3 }))).toBe(false);
  });

  it('refuses one whose new pod is up but not ready', () => {
    expect(hasSettled(deployment({ readyReplicas: 0 }))).toBe(false);
  });

  it('refuses one still carrying a replica on the old image', () => {
    expect(hasSettled(deployment({ updatedReplicas: 0 }))).toBe(false);
  });

  it('refuses a Deployment scaled to zero, which runs no image at all', () => {
    expect(
      hasSettled({ metadata: { generation: 1 }, spec: { replicas: 0 } }),
    ).toBe(false);
  });
});
