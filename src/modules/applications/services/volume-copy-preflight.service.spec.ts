/**
 * The client library ships ESM and this project's jest transforms only `jose`,
 * so it is replaced wholesale. Nothing here reaches it: the guard's two
 * collaborators are stubbed, and only their shapes matter.
 */
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { VolumeCopyPreflightService } from './volume-copy-preflight.service';

describe('VolumeCopyPreflightService', () => {
  function make(
    opts: {
      writers?: string[];
      engine?: string | null;
      engineLabel?: string;
      hookOutput?: string;
    } = {},
  ) {
    const k8s = {
      findPodsMountingPvc: jest.fn(async () => opts.writers ?? []),
      describePod: jest.fn(async () => ({
        labels: opts.engineLabel
          ? { 'flui.cloud/db-engine': opts.engineLabel }
          : {},
        container: 'main',
      })),
      execInPod: jest.fn(async () => opts.hookOutput ?? 'FLUI_HOOK_OK\n'),
    };
    const volumeExport = {
      probeDataDirectory: jest.fn(async () => opts.engine),
    };
    const pauseLease = {
      acquire: jest.fn(async () => [
        { kind: 'StatefulSet', name: 'pg', namespace: 'ns', replicas: 1 },
      ]),
      release: jest.fn(async () => {}),
    };
    return {
      service: new VolumeCopyPreflightService(
        k8s as any,
        volumeExport as any,
        pauseLease as any,
      ),
      k8s,
      volumeExport,
      pauseLease,
    };
  }

  const input = { kubeconfig: 'kc', namespace: 'ns', pvcName: 'data-pg-0' };

  it('does not probe a volume nothing is writing to', async () => {
    const { service, volumeExport } = make({ writers: [] });

    await expect(service.check(input)).resolves.toEqual({
      facts: { quiesce: 'none', writersAtStart: 0 },
      paused: [],
    });
    expect(volumeExport.probeDataDirectory).not.toHaveBeenCalled();
  });

  it('refuses a live copy of a database, naming the way forward', async () => {
    const { service } = make({ writers: ['pg-0'], engine: 'postgres' });

    await expect(service.check(input)).rejects.toMatchObject({
      response: {
        code: 'VOLUME_COPY_REFUSED',
        dataDirectoryDetected: 'postgres',
        writersAtStart: 1,
      },
    });
  });

  it('proceeds on an acknowledged copy of an engine that survives a crash', async () => {
    const { service } = make({ writers: ['db-0'], engine: 'mysql' });

    await expect(
      service.check({ ...input, allowInconsistent: true }),
    ).resolves.toEqual({
      facts: {
        quiesce: 'none',
        writersAtStart: 1,
        dataDirectoryDetected: 'mysql',
        acknowledgedInconsistent: true,
      },
      paused: [],
    });
  });

  it('refuses an engine written in place even when acknowledged', async () => {
    const { service } = make({ writers: ['meili-0'], engine: 'meilisearch' });

    // The flag would produce a file that cannot be opened again, and would
    // then count as a successful backup in every listing. That is not a
    // decision to offer someone.
    await expect(
      service.check({ ...input, allowInconsistent: true }),
    ).rejects.toMatchObject({
      response: { code: 'VOLUME_COPY_REFUSED', options: ['pause'] },
    });
  });

  it('pauses instead of probing, and says the writers were stopped', async () => {
    const { service, pauseLease, volumeExport } = make({
      writers: ['pg-0'],
      engine: 'postgres',
    });

    const result = await service.check({ ...input, pause: true });

    expect(pauseLease.acquire).toHaveBeenCalled();
    expect(result.facts.quiesce).toBe('writers-stopped');
    expect(result.paused).toHaveLength(1);
    // With the writers stopped there is nothing to refuse and nothing the
    // probe could change, so it is not worth a pod.
    expect(volumeExport.probeDataDirectory).not.toHaveBeenCalled();
  });

  it('does not claim writers were stopped when there were none', async () => {
    const { service, pauseLease } = make({ writers: [] });

    const result = await service.check({ ...input, pause: true });

    expect(pauseLease.acquire).not.toHaveBeenCalled();
    expect(result.facts.quiesce).toBe('none');
  });

  it('runs the engine hook instead of refusing, when the engine has one', async () => {
    const { service, k8s } = make({
      writers: ['redis-0'],
      engine: 'redis',
      engineLabel: 'redis',
    });

    const result = await service.check(input);

    // Nothing stopped and nothing torn: Redis wrote a whole RDB and renamed it
    // into place, and the copy reads that.
    expect(k8s.execInPod).toHaveBeenCalled();
    expect(result.facts).toMatchObject({
      quiesce: 'engine-hook',
      hook: 'redis-bgsave',
      dataDirectoryDetected: 'redis',
    });
  });

  it('runs the hook even when the disk shows no marker yet', async () => {
    const { service, k8s, volumeExport } = make({
      writers: ['redis-0'],
      engine: null, // the probe would find nothing
      engineLabel: 'redis',
    });

    const result = await service.check(input);

    expect(k8s.execInPod).toHaveBeenCalled();
    expect(result.facts.quiesce).toBe('engine-hook');
    expect(volumeExport.probeDataDirectory).not.toHaveBeenCalled();
  });

  it('refuses when the hook ran but did not confirm', async () => {
    const { service } = make({
      writers: ['redis-0'],
      engine: 'redis',
      engineLabel: 'redis',
      hookOutput: 'BGSAVE reported err',
    });

    await expect(service.check(input)).rejects.toMatchObject({
      response: { code: 'VOLUME_COPY_REFUSED' },
    });
  });

  it('still refuses an engine that has no hook', async () => {
    const { service, k8s } = make({
      writers: ['pg-0'],
      engine: 'postgres',
      engineLabel: 'postgres',
    });

    await expect(service.check(input)).rejects.toMatchObject({
      response: { dataDirectoryDetected: 'postgres' },
    });
    expect(k8s.execInPod).not.toHaveBeenCalled();
  });

  it('allows a live copy of a volume that holds no database', async () => {
    const { service } = make({ writers: ['web-0'], engine: null });

    await expect(service.check(input)).resolves.toEqual({
      facts: {
        quiesce: 'none',
        writersAtStart: 1,
        dataDirectoryDetected: null,
      },
      paused: [],
    });
  });

  it('does not refuse when the probe could not run, and says it did not', async () => {
    const { service } = make({ writers: ['web-0'], engine: undefined });

    // Refusing on a failed probe would block every copy the moment the probe
    // breaks; the honest cost is that the row says the volume was never
    // inspected, rather than claiming it came back clean.
    await expect(service.check(input)).resolves.toEqual({
      facts: {
        quiesce: 'none',
        writersAtStart: 1,
        dataDirectoryDetected: undefined,
      },
      paused: [],
    });
  });

  it('acknowledges nothing when there was nothing to acknowledge', async () => {
    const { service } = make({ writers: ['web-0'], engine: null });

    const result = await service.check({ ...input, allowInconsistent: true });

    expect(result.facts).not.toHaveProperty('acknowledgedInconsistent');
  });
});
