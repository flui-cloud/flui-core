import { DrainCheck } from './drain.core';
import { FitCheck } from './fit.core';
import { RemovalPreviewInput, previewRemoval } from './removal-preview.core';

const clear: DrainCheck = {
  ok: true,
  blockers: [],
  cleared: [],
  moves: [
    { what: 'it-tools', system: false },
    { what: 'flui-web', system: true },
  ],
};
const fits: FitCheck = {
  fits: true,
  needs: { cpuMillicores: 300, memoryMi: 400 },
  room: { cpuMillicores: 2000, memoryMi: 4000 },
  stranded: [],
};

const input = (
  over: Partial<RemovalPreviewInput> = {},
): RemovalPreviewInput => ({
  fleet: 2,
  min: 1,
  desired: 1,
  controlCluster: true,
  candidate: { name: 'staging-worker-1', shape: 'cx23' },
  drain: clear,
  fit: fits,
  ...over,
});

describe('what saving lower node limits does to the machines', () => {
  it('says nothing changes when the fleet already sits at the new target', () => {
    const preview = previewRemoval(input({ desired: 2 }));

    expect(preview.removes).toBe(false);
    expect(preview.sentence).toBe(
      'Saving changes no machine: the cluster has 2 node(s) and the target is 2.',
    );
  });

  it('names the machine, opens the master first and lists what moves, Flui first', () => {
    const preview = previewRemoval(input());

    expect(preview).toMatchObject({
      removes: true,
      proceeds: true,
      opensMaster: true,
      node: 'staging-worker-1',
      leaving: 1,
    });
    expect(preview.sentence).toBe(
      'Saving removes staging-worker-1 (cx23). The master takes apps again first, so what runs on it has somewhere to start. Started again on another machine: flui-web (Flui), it-tools.',
    );
  });

  it('waits, touching nothing, when the machine runs the Flui API', () => {
    const preview = previewRemoval(
      input({
        drain: {
          ok: false,
          blockers: [
            {
              kind: 'runs-flui-api',
              what: 'flui-system/flui-api-5f597b7d65-gcrhj',
              fix: 'x',
            },
          ],
          cleared: [],
        },
        fit: null,
      }),
    );

    expect(preview.proceeds).toBe(false);
    expect(preview.waitsFor.map((r) => r.kind)).toEqual(['runs-flui-api']);
    expect(preview.sentence).toBe(
      'Flui would remove staging-worker-1, but not now: the Flui API runs on it. The removal waits, and nothing on staging-worker-1 is touched.',
    );
  });

  it('waits when what runs on the machine would not fit elsewhere', () => {
    const preview = previewRemoval(
      input({
        fit: { ...fits, fits: false, stranded: ['flui-api'] },
      }),
    );

    expect(preview.proceeds).toBe(false);
    expect(preview.sentence).toContain('but not now');
    expect(preview.sentence).toContain(
      'nothing on staging-worker-1 is touched',
    );
  });

  it('never reads silence as a yes', () => {
    const preview = previewRemoval(input({ drain: null, fit: null }));

    expect(preview.proceeds).toBe(false);
    expect(preview.sentence).toContain('could not be asked what runs on it');
  });

  it('does not open the master of a workload cluster, and says when more follow', () => {
    const preview = previewRemoval(input({ fleet: 4, controlCluster: false }));

    expect(preview.opensMaster).toBe(false);
    expect(preview.leaving).toBe(3);
    expect(preview.sentence).toContain(
      'Then 2 more, one at a time, each checked the same way.',
    );
  });

  it('keeps a floor above the target as the resting point', () => {
    const preview = previewRemoval(input({ fleet: 3, min: 3, desired: 1 }));

    expect(preview.removes).toBe(false);
    expect(preview.target).toBe(3);
  });
});

describe('the short form a screen shows beside its own list', () => {
  it('leaves the list of what moves out of the headline', () => {
    const preview = previewRemoval(input());

    expect(preview.headline).toBe(
      'Saving removes staging-worker-1 (cx23). The master takes apps again first, so what runs on it has somewhere to start.',
    );
    expect(preview.sentence).toContain('Started again on another machine');
  });

  it('is the sentence itself when nothing moves', () => {
    const preview = previewRemoval(input({ desired: 2 }));
    expect(preview.headline).toBe(preview.sentence);
  });
});
