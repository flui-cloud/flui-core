/**
 * How long each part of building a tenancy took.
 *
 * The buffer of warm tenancies is sized against this number, so it has to be a
 * measurement rather than a guess. It also has to be broken down: a single
 * "ninety seconds" hides that nearly all of it is one step — waiting for the
 * seeded application to actually run — and that everything around it is
 * already close to instant. A buffer sized against the total would be paying
 * for the parts that cost nothing.
 *
 * Deliberately not a database column. This is operational detail with a
 * lifetime of one build; it belongs in the log line that says the build
 * finished, next to the name of the tenancy it describes.
 */
export class SandboxBuildTimeline {
  private readonly marks: { step: string; at: number }[] = [];

  constructor(private readonly startedAt: number = Date.now()) {}

  mark(step: string): void {
    this.marks.push({ step, at: Date.now() });
  }

  get totalMs(): number {
    const last = this.marks.at(-1);
    return (last?.at ?? Date.now()) - this.startedAt;
  }

  /** Each step and how long it took, not how long had elapsed when it ended. */
  steps(): { step: string; ms: number }[] {
    let previous = this.startedAt;
    return this.marks.map(({ step, at }) => {
      const ms = at - previous;
      previous = at;
      return { step, ms };
    });
  }

  toString(): string {
    const parts = this.steps().map(
      ({ step, ms }) => `${step} ${(ms / 1000).toFixed(1)}s`,
    );
    return `${(this.totalMs / 1000).toFixed(1)}s total — ${parts.join(', ')}`;
  }
}
