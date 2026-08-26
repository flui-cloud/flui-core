import {
  durationsOf,
  medianMs,
  noBuildExpectation,
  summariseBuildDurations,
} from './build-expectation';

const at = (iso: string) => new Date(iso);

/**
 * The rule this file exists to enforce: no figure without a measurement behind
 * it, and the sample size always travels with the figure. A median presented
 * bare is indistinguishable from a constant somebody typed.
 */
describe('what a build here has actually cost', () => {
  describe('turning rows into durations', () => {
    it('ignores a build that never finished', () => {
      expect(
        durationsOf([
          { startedAt: at('2026-08-24T10:00:00Z'), completedAt: null },
        ]),
      ).toEqual([]);
    });

    it('ignores a build that never started', () => {
      expect(
        durationsOf([
          { startedAt: null, completedAt: at('2026-08-24T10:00:00Z') },
        ]),
      ).toEqual([]);
    });

    it('ignores a row whose timestamps run backwards', () => {
      expect(
        durationsOf([
          {
            startedAt: at('2026-08-24T10:05:00Z'),
            completedAt: at('2026-08-24T10:00:00Z'),
          },
        ]),
      ).toEqual([]);
    });

    it('drops an implausible span rather than let it drag the median', () => {
      expect(
        durationsOf([
          {
            startedAt: at('2026-08-24T10:00:00Z'),
            completedAt: at('2026-08-25T10:00:00Z'),
          },
        ]),
      ).toEqual([]);
    });

    it('keeps a real one', () => {
      expect(
        durationsOf([
          {
            startedAt: at('2026-08-24T10:00:00Z'),
            completedAt: at('2026-08-24T10:03:12Z'),
          },
        ]),
      ).toEqual([192_000]);
    });
  });

  describe('the median', () => {
    it('is nothing when there is nothing', () => {
      expect(medianMs([])).toBeNull();
    });

    it('is the middle of an odd sample', () => {
      expect(medianMs([300, 100, 200])).toBe(200);
    });

    it('is the mean of the two middles of an even sample', () => {
      expect(medianMs([100, 200, 300, 500])).toBe(250);
    });
  });

  describe('the sentence a person reads', () => {
    it('gives no number at all when nothing has been measured', () => {
      const none = noBuildExpectation();
      expect(none.samples).toBe(0);
      expect(none.medianSeconds).toBeNull();
      expect(none.slowestSeconds).toBeNull();
      expect(none.note).toContain('Nothing measured yet');
    });

    it('falls back to nothing measured when handed an empty sample', () => {
      expect(summariseBuildDurations([], 'this-application').source).toBe(
        'none',
      );
    });

    it('reports minutes when the builds took minutes, not a rounded-down zero', () => {
      const summary = summariseBuildDurations(
        [170_000, 190_000, 210_000],
        'this-application',
      );
      expect(summary.medianSeconds).toBe(190);
      expect(summary.note).toContain('3m 10s');
      expect(summary.samples).toBe(3);
    });

    it('carries the slowest of the sample so the median is not read as a ceiling', () => {
      const summary = summariseBuildDurations(
        [120_000, 180_000, 600_000],
        'this-application',
      );
      expect(summary.slowestSeconds).toBe(600);
      expect(summary.note).toContain('10m');
    });

    it('says the sample size in the sentence, every time', () => {
      expect(
        summariseBuildDurations([120_000, 180_000], 'this-application').note,
      ).toContain('last 2 builds');
      expect(
        summariseBuildDurations([120_000, 180_000], 'your-recent-builds').note,
      ).toContain('Your last 2 builds');
    });

    it('refuses to call a single measurement an average', () => {
      const summary = summariseBuildDurations([185_000], 'this-application');
      expect(summary.note).toContain('One measurement is not an average');
    });

    it('says whose builds the figure came from', () => {
      expect(summariseBuildDurations([1000], 'your-recent-builds').source).toBe(
        'your-recent-builds',
      );
    });
  });
});
