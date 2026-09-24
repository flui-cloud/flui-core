import { checkFit, fitSummary } from './fit.core';

const pod = (name: string, cpuMillicores: number, memoryMi: number) => ({
  name,
  cpuMillicores,
  memoryMi,
});
const room = pod;

describe('whether the work on a node fits without it', () => {
  it('fits when the machines that stay have room on both counts', () => {
    const fit = checkFit(
      [pod('api', 500, 512), pod('web', 250, 256)],
      [room('master', 1000, 1024)],
    );
    expect(fit.fits).toBe(true);
    expect(fit.stranded).toEqual([]);
  });

  it('keeps the node when one app cannot be placed anywhere', () => {
    const fit = checkFit(
      [pod('heavy', 3000, 512)],
      [room('master', 2400, 8192)],
    );
    expect(fit.fits).toBe(false);
    expect(fit.stranded).toEqual(['heavy']);
  });

  /**
   * The totals would fit and the pieces do not: two half-empty machines are not
   * one empty machine.
   */
  it('does not add up room that is split across machines', () => {
    const fit = checkFit(
      [pod('big', 1500, 256)],
      [room('a', 1000, 4096), room('b', 1000, 4096)],
    );
    expect(fit.needs.cpuMillicores).toBeLessThan(fit.room.cpuMillicores);
    expect(fit.fits).toBe(false);
  });

  it('places the hardest first, so a greedy fill does not waste the only machine that could take it', () => {
    const fit = checkFit(
      [pod('small', 100, 256), pod('large', 100, 3072)],
      [room('roomy', 1000, 3200), room('tight', 1000, 512)],
    );
    expect(fit.fits).toBe(true);
  });

  it('fits nothing onto no machines at all', () => {
    expect(checkFit([pod('api', 100, 128)], []).fits).toBe(false);
  });

  it('gives back a node with nothing on it', () => {
    expect(checkFit([], []).fits).toBe(true);
  });

  it('names what would be stranded, and what it needed against what there was', () => {
    const line = fitSummary(
      checkFit([pod('heavy', 3000, 512)], [room('master', 2400, 8192)]),
    );
    expect(line).toContain('3000m of CPU');
    expect(line).toContain('2400m');
    expect(line).toContain('heavy would have nowhere to run');
  });
});
