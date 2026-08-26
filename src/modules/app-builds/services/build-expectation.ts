/**
 * How long a build here actually takes, said as a measurement or not said.
 *
 * A screen that promises a minute and then takes three teaches the person
 * watching it that the product's numbers are decoration. The way out is not a
 * more generous constant — it is to stop having a constant. Every figure below
 * comes from builds that really finished, carries the number of them it came
 * from, and is absent when there is nothing to measure.
 *
 * The samples are always the caller's own. An instance-wide median would be a
 * better estimate and a worse answer: on a shared demo it would carry timings
 * derived from other people's repositories out to a stranger.
 */

export type BuildExpectationSource =
  | 'this-application'
  | 'your-recent-builds'
  | 'none';

export interface BuildExpectation {
  /** How many finished builds the figures rest on. Zero means no figures. */
  samples: number;
  medianSeconds: number | null;
  /** The worst of the sample, so the number is not read as a ceiling. */
  slowestSeconds: number | null;
  source: BuildExpectationSource;
  /** The whole thing in one sentence, sample size included. */
  note: string;
}

/** A build that started and finished. Anything else cannot be measured. */
export interface FinishedBuild {
  startedAt?: Date | null;
  completedAt?: Date | null;
}

/**
 * Six hours. Past this the pair of timestamps is describing a row that was
 * never closed rather than a build that ran, and one of those in the sample
 * moves a median far enough to be its own kind of lie.
 */
const IMPLAUSIBLE_MS = 6 * 60 * 60 * 1000;

export function durationsOf(builds: FinishedBuild[]): number[] {
  return builds
    .map((b) =>
      b.startedAt && b.completedAt
        ? b.completedAt.getTime() - b.startedAt.getTime()
        : Number.NaN,
    )
    .filter((ms) => Number.isFinite(ms) && ms > 0 && ms < IMPLAUSIBLE_MS);
}

export function medianMs(durationsMs: number[]): number | null {
  if (durationsMs.length === 0) return null;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export function noBuildExpectation(): BuildExpectation {
  return {
    samples: 0,
    medianSeconds: null,
    slowestSeconds: null,
    source: 'none',
    note: 'Nothing measured yet — this is the first build we would have timed. It runs on GitHub-hosted runners and takes minutes, not seconds; the clock on this screen is the real one.',
  };
}

export function summariseBuildDurations(
  durationsMs: number[],
  source: 'this-application' | 'your-recent-builds',
): BuildExpectation {
  if (durationsMs.length === 0) return noBuildExpectation();

  const median = medianMs(durationsMs)!;
  const medianSeconds = Math.round(median / 1000);
  const slowestSeconds = Math.round(Math.max(...durationsMs) / 1000);
  const many = durationsMs.length > 1;
  const plural = many ? 's' : '';
  const subject =
    source === 'this-application'
      ? `The last ${durationsMs.length} build${plural} of this application`
      : `Your last ${durationsMs.length} build${plural}`;

  const note = many
    ? `${subject} took a median of ${formatDuration(medianSeconds)}, the slowest ${formatDuration(slowestSeconds)}.`
    : `${subject} took ${formatDuration(medianSeconds)}. One measurement is not an average.`;

  return {
    samples: durationsMs.length,
    medianSeconds,
    slowestSeconds,
    source,
    note,
  };
}
