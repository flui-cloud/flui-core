import { SandboxBuildTimeline } from './sandbox-build-timeline';

describe('SandboxBuildTimeline', () => {
  let now = 1_000_000;

  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => jest.restoreAllMocks());

  /**
   * The whole reason this exists: a total of "ninety seconds" would have the
   * buffer sized against a number that is almost entirely one step.
   */
  it('reports each step on its own, not the elapsed time when it ended', () => {
    const timeline = new SandboxBuildTimeline();
    now += 2_000;
    timeline.mark('identity');
    now += 1_000;
    timeline.mark('namespace');
    now += 110_000;
    timeline.mark('seed running');

    expect(timeline.steps()).toEqual([
      { step: 'identity', ms: 2_000 },
      { step: 'namespace', ms: 1_000 },
      { step: 'seed running', ms: 110_000 },
    ]);
    expect(timeline.totalMs).toBe(113_000);
  });

  it('reads as one line with the total in front', () => {
    const timeline = new SandboxBuildTimeline();
    now += 1_500;
    timeline.mark('identity');
    now += 88_500;
    timeline.mark('seed running');

    expect(String(timeline)).toBe(
      '90.0s total — identity 1.5s, seed running 88.5s',
    );
  });

  // A build that dies partway is the case the timeline is most useful for.
  it('measures a build that never reached its last step', () => {
    const timeline = new SandboxBuildTimeline();
    now += 3_000;
    timeline.mark('identity');

    expect(timeline.totalMs).toBe(3_000);
    expect(timeline.steps()).toEqual([{ step: 'identity', ms: 3_000 }]);
  });
});
